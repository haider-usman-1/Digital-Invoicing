/**
 * Append-only submission log.
 *
 * This is an event log rather than a mutable record, for a specific reason: the attempt must be on
 * disk BEFORE the request goes out. FBR has no idempotency key and no read API, so if this process
 * dies mid-submit the only evidence that an invoice might exist is what we wrote beforehand. You
 * cannot rewrite a line in an append-only file, so the result arrives as a second event and the
 * current state is folded at read time.
 *
 * The attempt event stores the full payload as sent. Reconciling an uncertain submission means a
 * human searching the IRIS portal by date, buyer and amount — without the payload, that search is
 * guesswork.
 *
 * Tokens are never written here.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SUBMISSIONS_FILE, dataFile } from "./paths.ts";
import type { RejectionError } from "../core/outcome.ts";
import type { Env, FbrInvoicePayload } from "../core/types.ts";

export interface AttemptDetails {
  accountId: string;
  accountLabel: string;
  env: Env;
  /** The user's own invoice reference. Not sent to FBR — see src/core/payload.ts. */
  internalInvoiceNumber: string;
  payload: FbrInvoicePayload;
}

export type SubmissionResult =
  | { kind: "success"; irn: string; dated: string | null }
  | { kind: "rejected"; errors: RejectionError[] }
  | { kind: "uncertain"; reason: string };

export type LogEvent =
  | ({ type: "SUBMIT_ATTEMPTED"; id: string; at: string } & AttemptDetails)
  | { type: "SUBMIT_RESULT"; id: string; at: string; result: SubmissionResult }
  | { type: "RESOLVED"; id: string; at: string; irn: string; note: string };

export type SubmissionStatus = "pending" | "success" | "rejected" | "uncertain" | "resolved";

export interface Submission extends AttemptDetails {
  id: string;
  at: string;
  status: SubmissionStatus;
  irn: string | null;
  dated: string | null;
  errors: RejectionError[];
  /** Why the outcome is unknown, when it is. */
  reason: string | null;
  /** What the user wrote when closing out an uncertain submission by hand. */
  resolutionNote: string | null;
}

function logPath(): string {
  return dataFile(SUBMISSIONS_FILE);
}

function append(event: LogEvent): void {
  // Synchronous on purpose: the attempt record has to be durable before the network call, and an
  // async write could still be buffered when the process dies.
  appendFileSync(logPath(), `${JSON.stringify(event)}\n`, "utf8");
}

/** Records the attempt and returns its id. Call this BEFORE contacting FBR. */
export function recordAttempt(details: AttemptDetails): string {
  const id = randomUUID();
  append({ type: "SUBMIT_ATTEMPTED", id, at: new Date().toISOString(), ...details });
  return id;
}

export function recordResult(id: string, result: SubmissionResult): void {
  append({ type: "SUBMIT_RESULT", id, at: new Date().toISOString(), result });
}

/** Closes out an uncertain submission with an IRN the user found in the IRIS portal. */
export function recordResolution(id: string, irn: string, note: string): void {
  append({ type: "RESOLVED", id, at: new Date().toISOString(), irn, note });
}

export function readEvents(): LogEvent[] {
  const path = logPath();
  if (!existsSync(path)) return [];

  const events: LogEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as LogEvent);
    } catch {
      // A torn final line from an unclean shutdown shouldn't hide the rest of the history.
    }
  }
  return events;
}

/** Folds the event log into current state, newest first. */
export function foldSubmissions(events: LogEvent[] = readEvents()): Submission[] {
  const byId = new Map<string, Submission>();

  for (const event of events) {
    if (event.type === "SUBMIT_ATTEMPTED") {
      const { type, ...rest } = event;
      byId.set(event.id, {
        ...rest,
        // Until a result event arrives this is genuinely unresolved: either still in flight, or
        // the app stopped before FBR's reply landed.
        status: "pending",
        irn: null,
        dated: null,
        errors: [],
        reason: null,
        resolutionNote: null,
      });
      continue;
    }

    const existing = byId.get(event.id);
    if (!existing) continue; // A result with no attempt means a hand-edited file; ignore it.

    if (event.type === "SUBMIT_RESULT") {
      const { result } = event;
      existing.status = result.kind;
      existing.irn = result.kind === "success" ? result.irn : null;
      existing.dated = result.kind === "success" ? result.dated : null;
      existing.errors = result.kind === "rejected" ? result.errors : [];
      existing.reason = result.kind === "uncertain" ? result.reason : null;
      continue;
    }

    existing.status = "resolved";
    existing.irn = event.irn;
    existing.resolutionNote = event.note;
  }

  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Submissions needing human attention: in flight, or ended without a clear answer.
 *
 * `pending` belongs here because a missing result event means the app stopped mid-submit, and the
 * invoice may still have been filed.
 */
export function needsAttention(submissions: Submission[] = foldSubmissions()): Submission[] {
  return submissions.filter((s) => s.status === "uncertain" || s.status === "pending");
}

/**
 * Scenario IDs an account has actually completed in sandbox.
 *
 * Only a successful POST counts. A passing `validateinvoicedata` call does not move an account
 * toward its production token, so counting it would show false progress.
 */
export function completedScenarios(accountId: string, submissions: Submission[] = foldSubmissions()): Set<string> {
  const done = new Set<string>();
  for (const submission of submissions) {
    if (submission.accountId !== accountId) continue;
    if (submission.env !== "sandbox") continue;
    if (submission.status !== "success" && submission.status !== "resolved") continue;
    const scenarioId = submission.payload.scenarioId;
    if (scenarioId) done.add(scenarioId);
  }
  return done;
}

/** The details a user needs to find an uncertain invoice in the IRIS portal by hand. */
export function portalSearchHints(submission: Submission): {
  invoiceDate: string;
  buyerName: string;
  buyerNTNCNIC: string;
  totalExcludingTax: number;
  sellerNTNCNIC: string;
} {
  const { payload } = submission;
  return {
    invoiceDate: payload.invoiceDate,
    buyerName: payload.buyerBusinessName,
    buyerNTNCNIC: payload.buyerNTNCNIC,
    totalExcludingTax: payload.items.reduce((sum, item) => sum + item.valueSalesExcludingST, 0),
    sellerNTNCNIC: payload.sellerNTNCNIC,
  };
}
