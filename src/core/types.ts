/**
 * Shared types for the FBR Digital Invoicing client.
 *
 * Wire-format types (prefixed `Fbr`) mirror PRAL's Technical Specification for DI API v1.12
 * EXACTLY, including its inconsistent casing (`uoM`, `sellerNTNCNIC`). Do not "tidy" these names.
 * Where the spec's field-description table disagrees with its own sample JSON, the sample wins —
 * that is what PRAL validates against. See docs/superpowers/specs/ for the full field analysis.
 */

export type Env = "sandbox" | "production";

/**
 * The shape of every HS code FBR issues: four digits, a dot, four digits.
 *
 * Checked against all 7,809 codes returned by the live `itemdesccode` endpoint — every one matches.
 * Used to avoid asking FBR about half-typed codes.
 */
export const HS_CODE_PATTERN = /^\d{4}\.\d{4}$/;

// ---------------------------------------------------------------------------
// Local configuration
// ---------------------------------------------------------------------------

/**
 * A seller registration.
 *
 * The account atomically owns its seller block AND both tokens. FBR binds each token to the NTN it
 * was issued to and rejects mismatches with error 0401/0402, so these must never drift apart: the
 * invoice form selects an account, it never edits seller fields on their own.
 */
export interface Account {
  id: string;
  label: string;

  // Seller block, sent verbatim on every invoice.
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;

  sandboxToken: string;
  productionToken: string;

  /**
   * Scenario IDs this registration must pass in sandbox, e.g. ["SN001", "SN002"].
   *
   * Taken from the user's IRIS dashboard "Eligible Scenarios" tile, which is authoritative. The
   * spec's own Business-Nature x Sector matrix has duplicate and missing rows, so it is NOT
   * hard-coded here.
   */
  eligibleScenarios: string[];
}

// ---------------------------------------------------------------------------
// Wire format — request
// ---------------------------------------------------------------------------

export interface FbrInvoiceItem {
  hsCode: string;
  productDescription: string;
  /** `ratE_DESC` from SaleTypeToRate, e.g. "18%". A string, not a number. */
  rate: string;
  /** Note the casing: lowercase u, lowercase o, capital M. `description` from the uom endpoint. */
  uoM: string;
  quantity: number;
  totalValues: number;
  valueSalesExcludingST: number;
  fixedNotifiedValueOrRetailPrice: number;
  salesTaxApplicable: number;
  salesTaxWithheldAtSource: number;
  extraTax: number;
  furtherTax: number;
  sroScheduleNo: string;
  fedPayable: number;
  discount: number;
  /** `transactioN_DESC` from transtypecode, e.g. "Goods at standard rate (default)". */
  saleType: string;
  sroItemSerialNo: string;
}

export interface FbrInvoicePayload {
  invoiceType: "Sale Invoice";
  /** YYYY-MM-DD, in Pakistan's local date. */
  invoiceDate: string;
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  buyerNTNCNIC: string;
  buyerBusinessName: string;
  buyerProvince: string;
  buyerAddress: string;
  buyerRegistrationType: BuyerRegistrationType;
  invoiceRefNo: string;
  /** Present ONLY in sandbox. Deleted entirely for production, not blanked. */
  scenarioId?: string;
  items: FbrInvoiceItem[];
}

export type BuyerRegistrationType = "Registered" | "Unregistered";

// ---------------------------------------------------------------------------
// Wire format — response
// ---------------------------------------------------------------------------

export interface FbrItemStatus {
  itemSNo?: string | null;
  statusCode?: string | null;
  status?: string | null;
  /** Present on post, absent on validate. */
  invoiceNo?: string | null;
  /** "" on post-success, null on validate. Handle both. */
  errorCode?: string | null;
  error?: string | null;
}

export interface FbrValidationResponse {
  statusCode?: string | null;
  status?: string | null;
  errorCode?: string | null;
  error?: string | null;
  invoiceStatuses?: FbrItemStatus[] | null;
}

export interface FbrInvoiceResponse {
  /** The IRN. Present only on a successful post; absent from validate and from all failures. */
  invoiceNumber?: string | null;
  dated?: string | null;
  validationResponse?: FbrValidationResponse | null;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export interface Province {
  stateProvinceCode: number;
  stateProvinceDesc: string;
}

export interface HsCode {
  hS_CODE: string;
  description: string;
}

export interface TransactionType {
  transactioN_TYPE_ID: number;
  transactioN_DESC: string;
}

export interface UnitOfMeasure {
  uoM_ID: number;
  description: string;
}

export interface SaleTypeRate {
  ratE_ID: number;
  /** The string sent as the item's `rate`, e.g. "18%" or "18% along with rupees 60 per kilogram". */
  ratE_DESC: string;
  /** The numeric percentage only. For compound rates this is NOT the whole story. */
  ratE_VALUE: number;
}

export interface RegistrationTypeResponse {
  statuscode?: string | null;
  REGISTRATION_NO?: string | null;
  REGISTRATION_TYPE?: string | null;
}
