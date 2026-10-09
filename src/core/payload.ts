/**
 * Builds the invoice JSON exactly as FBR expects it.
 *
 * This is written field by field on purpose. Serialising a loose object would quietly get several
 * things wrong that FBR rejects:
 *
 *   - `scenarioId` must be ABSENT in production, not empty. FBR's production samples have no such
 *     key, and an empty string is a different thing from a missing one.
 *   - Nominally optional numeric fields are rejected when malformed (error 0300), so they are
 *     always real zeros rather than `null`, `""`, or omitted.
 *   - `buyerNTNCNIC` is a string. The spec's field table shows it unquoted; its sample JSON quotes
 *     it, and the sample is what PRAL validates against.
 *   - The casing is FBR's, warts and all: `uoM`, `sellerNTNCNIC`, `valueSalesExcludingST`.
 */

import type {
  Account,
  BuyerRegistrationType,
  Env,
  FbrInvoiceItem,
  FbrInvoicePayload,
} from "./types.ts";

export interface BuyerDetails {
  /** Blank is allowed when the buyer is unregistered. */
  ntncnic: string;
  businessName: string;
  province: string;
  address: string;
  registrationType: BuyerRegistrationType;
}

export interface InvoicePayloadInput {
  env: Env;
  account: Account;
  buyer: BuyerDetails;
  /** YYYY-MM-DD in Pakistan's local date. Use `pakistanDate()`. */
  invoiceDate: string;
  /** Sandbox only; ignored entirely in production. */
  scenarioId?: string;
  /**
   * The user's own invoice reference. Deliberately NOT sent to FBR — see the note on
   * `invoiceRefNo` below. It is recorded in the local submission log instead.
   */
  internalInvoiceNumber?: string;
  items: FbrInvoiceItem[];
}

function text(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function amount(value: number | undefined | null): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function buildItem(item: FbrInvoiceItem): FbrInvoiceItem {
  return {
    hsCode: text(item.hsCode),
    productDescription: text(item.productDescription),
    rate: text(item.rate),
    uoM: text(item.uoM),
    quantity: amount(item.quantity),
    totalValues: amount(item.totalValues),
    valueSalesExcludingST: amount(item.valueSalesExcludingST),
    fixedNotifiedValueOrRetailPrice: amount(item.fixedNotifiedValueOrRetailPrice),
    salesTaxApplicable: amount(item.salesTaxApplicable),
    salesTaxWithheldAtSource: amount(item.salesTaxWithheldAtSource),
    extraTax: amount(item.extraTax),
    furtherTax: amount(item.furtherTax),
    sroScheduleNo: text(item.sroScheduleNo),
    fedPayable: amount(item.fedPayable),
    discount: amount(item.discount),
    saleType: text(item.saleType),
    sroItemSerialNo: text(item.sroItemSerialNo),
  };
}

export function buildInvoicePayload(input: InvoicePayloadInput): FbrInvoicePayload {
  const { account, buyer } = input;

  const payload: FbrInvoicePayload = {
    invoiceType: "Sale Invoice",
    invoiceDate: text(input.invoiceDate),

    // The seller block always comes from the selected account. FBR binds each token to one NTN and
    // rejects a mismatch with error 0401, so these fields are never editable on the invoice form.
    sellerNTNCNIC: text(account.sellerNTNCNIC),
    sellerBusinessName: text(account.sellerBusinessName),
    sellerProvince: text(account.sellerProvince),
    sellerAddress: text(account.sellerAddress),

    buyerNTNCNIC: text(buyer.ntncnic),
    buyerBusinessName: text(buyer.businessName),
    buyerProvince: text(buyer.province),
    buyerAddress: text(buyer.address),
    buyerRegistrationType: buyer.registrationType,

    /*
     * Always empty for a sale invoice.
     *
     * `invoiceRefNo` is FBR's IRN of an ORIGINAL invoice and is only meaningful on a debit note.
     * The user's own invoice number does not belong here — putting it in earns error 0057,
     * "Reference Invoice does not exist". The internal reference is kept in the local log.
     */
    invoiceRefNo: "",

    items: input.items.map(buildItem),
  };

  // Sandbox only. Assigning conditionally keeps the key off the object entirely in production.
  const scenarioId = text(input.scenarioId);
  if (input.env === "sandbox" && scenarioId !== "") {
    payload.scenarioId = scenarioId;
  }

  return payload;
}

/**
 * Today's date in Pakistan, as YYYY-MM-DD.
 *
 * Deriving this from UTC would file on the wrong day for any invoice raised after 19:00 PKT, and
 * FBR only permits corrections back 3 days — so the mistake would often be unfixable.
 */
export function pakistanDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // en-CA already yields YYYY-MM-DD.
  return parts;
}
