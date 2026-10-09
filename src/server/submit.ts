/**
 * Two ways to send an invoice to FBR: check it, or file it.
 *
 * Filing always pre-checks first, as one user action — the extra call is free at a few invoices a
 * day and the payoff is never creating an ambiguous filing for a payload that was going to be
 * rejected anyway. `precheckInvoice` exposes that same check on its own, for when you want to know
 * an invoice is good without committing to it.
 *
 * A pre-check is never treated as a guarantee. FBR can still reject on the real post, so that path
 * is handled too.
 */

import { buildInvoicePayload } from "../core/payload.ts";
import type { BuyerDetails } from "../core/payload.ts";
import { interpretPostResponse, interpretValidateResponse } from "../core/outcome.ts";
import type { RejectionError } from "../core/outcome.ts";
import type { Account, Env, FbrInvoiceItem } from "../core/types.ts";
import { FbrClient } from "./fbr-client.ts";
import { portalSearchHints, recordAttempt, recordResult } from "./log.ts";
import type { Submission } from "./log.ts";
import { tokenFor } from "./store.ts";

export interface SubmitRequest {
  env: Env;
  buyer: BuyerDetails;
  invoiceDate: string;
  internalInvoiceNumber: string;
  scenarioId?: string;
  items: FbrInvoiceItem[];
}

export type SubmitResponse =
  | { status: "success"; irn: string; dated: string | null; submissionId: string }
  /** `stage` tells the user whether anything was ever sent for filing. Nothing was filed either way. */
  | { status: "rejected"; stage: "precheck" | "filing"; errors: RejectionError[]; submissionId: string | null }
  | {
      status: "uncertain";
      reason: string;
      submissionId: string;
      portalSearch: ReturnType<typeof portalSearchHints>;
    }
  | { status: "error"; message: string };

/** Outcome of a check that deliberately stops short of filing. */
export type PrecheckResponse =
  | { status: "valid" }
  | { status: "rejected"; errors: RejectionError[] }
  | { status: "error"; message: string };

/**
 * Shared preparation for both the check-only and the file-it-for-real paths.
 *
 * Extracted so the two cannot drift: a pre-check that built its payload even slightly differently
 * from the real submission would be worse than no pre-check at all, because it would pass and then
 * the filing would fail.
 */
function prepare(
  account: Account,
  request: SubmitRequest,
):
  | { ok: true; token: string; payload: ReturnType<typeof buildInvoicePayload> }
  | { ok: false; message: string } {
  const credentials = tokenFor(account, request.env);
  if (!credentials.ok) return { ok: false, message: credentials.reason };

  if (request.items.length === 0) {
    return { ok: false, message: "Add at least one line item before submitting." };
  }

  // FBR requires a scenario in sandbox and refuses one in production; the payload builder enforces
  // the latter, but a missing scenario in sandbox is worth catching before we spend a call.
  if (request.env === "sandbox" && !request.scenarioId?.trim()) {
    return { ok: false, message: "Pick a scenario. FBR requires one for every sandbox invoice." };
  }

  return {
    ok: true,
    token: credentials.token,
    payload: buildInvoicePayload({
      env: request.env,
      account,
      buyer: request.buyer,
      invoiceDate: request.invoiceDate,
      items: request.items,
      ...(request.scenarioId ? { scenarioId: request.scenarioId } : {}),
    }),
  };
}

/**
 * Runs FBR's pre-check and stops.
 *
 * `validateinvoicedata` files nothing, so this is always safe to repeat and never produces an
 * uncertain state. Nothing is written to the submission log either: the log records attempts to
 * file, and a check is not one. It therefore counts for nothing toward scenario completion, which
 * is correct — only a successful post moves an account toward its production token.
 */
export async function precheckInvoice(
  client: FbrClient,
  account: Account,
  request: SubmitRequest,
): Promise<PrecheckResponse> {
  const prepared = prepare(account, request);
  if (!prepared.ok) return { status: "error", message: prepared.message };

  const response = await client.validateInvoice(prepared.token, request.env, prepared.payload);
  if (response.transport !== "ok") {
    return { status: "error", message: `${response.reason} Nothing has been filed.` };
  }

  const outcome = interpretValidateResponse(response.body);
  if (outcome.kind === "valid") return { status: "valid" };
  if (outcome.kind === "rejected") return { status: "rejected", errors: outcome.errors };
  return { status: "error", message: `${outcome.reason} Nothing has been filed.` };
}

export async function submitInvoice(
  client: FbrClient,
  account: Account,
  request: SubmitRequest,
): Promise<SubmitResponse> {
  const prepared = prepare(account, request);
  if (!prepared.ok) return { status: "error", message: prepared.message };
  const { token, payload } = prepared;

  // --- Pre-check. This endpoint does not file anything, so a failure here is always safe. -------
  const precheck = await client.validateInvoice(token, request.env, payload);
  if (precheck.transport !== "ok") {
    return { status: "error", message: `${precheck.reason} Nothing has been filed — try again.` };
  }

  const precheckOutcome = interpretValidateResponse(precheck.body);
  if (precheckOutcome.kind === "rejected") {
    return { status: "rejected", stage: "precheck", errors: precheckOutcome.errors, submissionId: null };
  }
  if (precheckOutcome.kind === "uncertain") {
    return {
      status: "error",
      message: `${precheckOutcome.reason} Nothing has been filed — try again.`,
    };
  }

  // --- Filing. From here on the invoice may exist, so the attempt goes to disk first. -----------
  const submissionId = recordAttempt({
    accountId: account.id,
    accountLabel: account.label,
    env: request.env,
    internalInvoiceNumber: request.internalInvoiceNumber,
    payload,
  });

  const filing = await client.postInvoice(token, request.env, payload);

  if (filing.transport === "not-filed") {
    // A 401 is decided at the gateway before processing, so this is a definite failure.
    const error: RejectionError = {
      code: null,
      fbrMessage: filing.reason,
      plain: filing.reason,
      field: null,
      itemSNo: null,
    };
    recordResult(submissionId, { kind: "rejected", errors: [error] });
    return { status: "rejected", stage: "filing", errors: [error], submissionId };
  }

  if (filing.transport === "ambiguous") {
    recordResult(submissionId, { kind: "uncertain", reason: filing.reason });
    return {
      status: "uncertain",
      reason: filing.reason,
      submissionId,
      portalSearch: portalSearchHints(submissionFor(submissionId, account, request, payload)),
    };
  }

  const outcome = interpretPostResponse(filing.body);

  if (outcome.kind === "success") {
    recordResult(submissionId, { kind: "success", irn: outcome.irn, dated: outcome.dated });
    return { status: "success", irn: outcome.irn, dated: outcome.dated, submissionId };
  }

  if (outcome.kind === "rejected") {
    recordResult(submissionId, { kind: "rejected", errors: outcome.errors });
    return { status: "rejected", stage: "filing", errors: outcome.errors, submissionId };
  }

  recordResult(submissionId, { kind: "uncertain", reason: outcome.reason });
  return {
    status: "uncertain",
    reason: outcome.reason,
    submissionId,
    portalSearch: portalSearchHints(submissionFor(submissionId, account, request, payload)),
  };
}

/**
 * Builds the shape `portalSearchHints` needs without re-reading the log.
 *
 * Only the payload fields are used, so the status placeholders here are never surfaced.
 */
function submissionFor(
  id: string,
  account: Account,
  request: SubmitRequest,
  payload: ReturnType<typeof buildInvoicePayload>,
): Submission {
  return {
    id,
    at: new Date().toISOString(),
    accountId: account.id,
    accountLabel: account.label,
    env: request.env,
    internalInvoiceNumber: request.internalInvoiceNumber,
    payload,
    status: "uncertain",
    irn: null,
    dated: null,
    errors: [],
    reason: null,
    resolutionNote: null,
  };
}
