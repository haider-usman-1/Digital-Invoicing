/**
 * FBR endpoint URLs, written out literally.
 *
 * These are copied character for character from PRAL Technical Specification v1.12 sections 4 and
 * 5. Do not refactor them into a template — the inconsistencies are real and each one is a way to
 * get a silent 404 or an empty list:
 *
 *   - Three of the reference endpoints are on /pdi/v2/, the rest on /pdi/v1/.
 *   - Paths are mixed-case (SroSchedule, SaleTypeToRate, HS_UOM, SROItem) and case-sensitive.
 *   - The buyer-lookup endpoints are under /dist/v1/, a different base path again.
 *   - Query parameter naming is inconsistent between endpoints (origination_supplier_csv on
 *     SroSchedule vs originationSupplier on SaleTypeToRate).
 *
 * Note also that section 4 claims one URL serves both environments with routing by token, while
 * the samples in the same document give distinct _sb paths. The _sb paths are what integrators
 * actually use; the "same URL" note is stale text.
 */

import type { Env } from "./types.ts";

const GW = "https://gw.fbr.gov.pk";

export const INVOICE_ENDPOINTS = {
  post: {
    sandbox: `${GW}/di_data/v1/di/postinvoicedata_sb`,
    production: `${GW}/di_data/v1/di/postinvoicedata`,
  },
  validate: {
    sandbox: `${GW}/di_data/v1/di/validateinvoicedata_sb`,
    production: `${GW}/di_data/v1/di/validateinvoicedata`,
  },
} as const;

export function invoiceUrl(action: "post" | "validate", env: Env): string {
  return INVOICE_ENDPOINTS[action][env];
}

/** Reference endpoints v1 needs. The SRO family is deferred — see docs/ROADMAP.md. */
export const REFERENCE_ENDPOINTS = {
  provinces: `${GW}/pdi/v1/provinces`,
  hsCodes: `${GW}/pdi/v1/itemdesccode`,
  transactionTypes: `${GW}/pdi/v1/transtypecode`,
  unitsOfMeasure: `${GW}/pdi/v1/uom`,
  /** v2, and takes date + transTypeId + originationSupplier. */
  saleTypeToRate: `${GW}/pdi/v2/SaleTypeToRate`,
  /** v2, and takes hs_code + annexure_id. */
  hsCodeUom: `${GW}/pdi/v2/HS_UOM`,
} as const;

/** Buyer lookups live under a different base path. */
export const BUYER_ENDPOINTS = {
  registrationType: `${GW}/dist/v1/Get_Reg_Type`,
  activeTaxpayerStatus: `${GW}/dist/v1/statl`,
} as const;

/**
 * SaleTypeToRate's date parameter uses `DD-MMM-YYYY` (the spec's example is `24-Feb-2024`), which
 * is not the `YYYY-MM-DD` the invoice payload uses. Getting this wrong returns an empty rate list
 * rather than an error.
 */
export function referenceDateFormat(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}
