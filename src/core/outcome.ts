/**
 * The single place that decides whether FBR accepted an invoice.
 *
 * This exists as one module because FBR's response format has a trap that is easy to get wrong in
 * each place it is handled: on an item-level rejection the OUTER `statusCode` is "00" — the same
 * value a success uses — and only the outer `status` ("invalid", lowercase) and the item's own
 * `statusCode` reveal the failure (spec v1.12 section 4.1.5). Reading the outer statusCode alone
 * reports a filed invoice that does not exist.
 *
 * The rule: a post succeeded only if an invoice number came back AND every item status is "00".
 *
 * Anything we cannot confidently read is `uncertain`, never `rejected`. FBR has no idempotency key
 * and performs no retries, so an ambiguous response means the invoice may or may not be on file;
 * calling that a rejection would invite a duplicate filing.
 */

import { explain } from "./errors.ts";
import type { FbrInvoiceResponse, FbrItemStatus, FbrValidationResponse } from "./types.ts";

export interface RejectionError {
  /** FBR's error code, e.g. "0046". Null when FBR rejected something without naming a code. */
  code: string | null;
  /** FBR's own message, preserved verbatim. */
  fbrMessage: string;
  /** Our plain-language explanation, with FBR's wording appended. */
  plain: string;
  /** Payload field to highlight, when we can map it. */
  field: string | null;
  /** Line item number, or null for a header-level error. */
  itemSNo: string | null;
}

export type PostOutcome =
  | { kind: "success"; irn: string; dated: string | null }
  | { kind: "rejected"; errors: RejectionError[] }
  | { kind: "uncertain"; reason: string };

export type ValidateOutcome =
  | { kind: "valid" }
  | { kind: "rejected"; errors: RejectionError[] }
  | { kind: "uncertain"; reason: string };

const OK = "00";

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** FBR returns "Valid", "Invalid" and "invalid" interchangeably, so compare case-insensitively. */
function saysValid(status: string | null | undefined): boolean {
  return !isBlank(status) && status!.trim().toLowerCase() === "valid";
}

function itemAccepted(item: FbrItemStatus): boolean {
  if (item.statusCode?.trim() !== OK) return false;
  // An explicit non-"valid" status overrides an OK code; a missing status is not itself a failure.
  return isBlank(item.status) || saysValid(item.status);
}

/** True when the response envelope itself signals a problem, by code, status, or error code. */
function headerSignalsFailure(vr: FbrValidationResponse): boolean {
  if (!isBlank(vr.statusCode) && vr.statusCode!.trim() !== OK) return true;
  if (!isBlank(vr.status) && !saysValid(vr.status)) return true;
  if (!isBlank(vr.errorCode)) return true;
  return false;
}

function toRejection(code: string | null, message: string, itemSNo: string | null): RejectionError {
  const { plain, field } = explain(code, message);
  return { code, fbrMessage: message, plain, field, itemSNo };
}

function collectErrors(vr: FbrValidationResponse): RejectionError[] {
  const errors: RejectionError[] = [];

  for (const item of vr.invoiceStatuses ?? []) {
    if (itemAccepted(item)) continue;
    errors.push(
      toRejection(
        isBlank(item.errorCode) ? null : item.errorCode!.trim(),
        item.error ?? "",
        isBlank(item.itemSNo) ? null : item.itemSNo!.trim(),
      ),
    );
  }

  // Only add a header-level error if FBR actually said something there. On item-level rejections the
  // envelope carries an empty `error`, and inventing a second error from it would double-report.
  const hasHeaderDetail = !isBlank(vr.errorCode) || !isBlank(vr.error);
  if (headerSignalsFailure(vr) && hasHeaderDetail) {
    errors.push(
      toRejection(isBlank(vr.errorCode) ? null : vr.errorCode!.trim(), vr.error ?? "", null),
    );
  }

  return errors;
}

export function interpretPostResponse(res: FbrInvoiceResponse): PostOutcome {
  const vr = res.validationResponse;
  if (!vr) {
    return {
      kind: "uncertain",
      reason:
        "FBR's reply didn't contain a validation result, so we can't tell whether the invoice was filed.",
    };
  }

  const errors = collectErrors(vr);
  const items = vr.invoiceStatuses ?? [];
  const everyItemAccepted = items.length > 0 && items.every(itemAccepted);
  const irn = isBlank(res.invoiceNumber) ? null : res.invoiceNumber!.trim();

  // All three conditions are required. The IRN is the only proof the invoice exists, and the
  // per-item check is what catches the outer-statusCode-"00" trap.
  if (irn !== null && everyItemAccepted && !headerSignalsFailure(vr)) {
    return { kind: "success", irn, dated: res.dated ?? null };
  }

  if (errors.length > 0) return { kind: "rejected", errors };

  return {
    kind: "uncertain",
    reason: irn
      ? "FBR returned an invoice number but didn't confirm the line items, so the filing can't be confirmed."
      : "FBR didn't return an invoice number and didn't report an error, so we can't tell whether the invoice was filed.",
  };
}

export function interpretValidateResponse(res: FbrInvoiceResponse): ValidateOutcome {
  const vr = res.validationResponse;
  if (!vr) {
    return { kind: "uncertain", reason: "FBR's reply didn't contain a validation result." };
  }

  const errors = collectErrors(vr);
  if (errors.length > 0) return { kind: "rejected", errors };

  // Validate never returns an invoice number, so per-item confirmation is the only signal there is.
  const items = vr.invoiceStatuses ?? [];
  if (items.length > 0 && items.every(itemAccepted) && !headerSignalsFailure(vr)) {
    return { kind: "valid" };
  }

  return {
    kind: "uncertain",
    reason: "FBR's pre-check didn't come back with a clear result for each line item.",
  };
}
