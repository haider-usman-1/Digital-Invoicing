/**
 * The submission flow: pre-check with FBR, then file, then record what happened.
 *
 * Presented to the user as ONE action. Exposing the pre-check as a separate button would invite
 * skipping it, and its whole value is never creating an ambiguous filing for a payload that was
 * going to be rejected anyway — at a few invoices a day the extra call costs nothing.
 *
 * The pre-check is not treated as a guarantee: FBR can still reject on the real post, so that path
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

export async function submitInvoice(
  client: FbrClient,
  account: Account,
  request: SubmitRequest,
): Promise<SubmitResponse> {
  const credentials = tokenFor(account, request.env);
  if (!credentials.ok) return { status: "error", message: credentials.reason };

  if (request.items.length === 0) {
    return { status: "error", message: "Add at least one line item before submitting." };
  }

  // FBR requires a scenario in sandbox and refuses one in production; the payload builder enforces
  // the latter, but a missing scenario in sandbox is worth catching before we spend a call.
  if (request.env === "sandbox" && !request.scenarioId?.trim()) {
    return {
      status: "error",
      message: "Pick a scenario. FBR requires one for every sandbox invoice.",
    };
  }

  const payload = buildInvoicePayload({
    env: request.env,
    account,
    buyer: request.buyer,
    invoiceDate: request.invoiceDate,
    items: request.items,
    ...(request.scenarioId ? { scenarioId: request.scenarioId } : {}),
  });

  // --- Pre-check. This endpoint does not file anything, so a failure here is always safe. -------
  const precheck = await client.validateInvoice(credentials.token, request.env, payload);
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

  const filing = await client.postInvoice(credentials.token, request.env, payload);

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
