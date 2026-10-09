/**
 * FBR sales error codes translated into language a non-accountant can act on, plus the form field
 * each one points at so the UI can highlight it.
 *
 * Codes and FBR's own wording come from PRAL Technical Specification v1.12 section 7. This table is
 * deliberately partial: it covers the codes reachable from the fields v1 actually sends. Anything
 * missing falls back to FBR's raw message, which is always surfaced rather than swallowed.
 */

export interface ErrorExplanation {
  /** Plain-language explanation, addressed to the person filling the form. */
  plain: string;
  /** Payload field this error points at, used to highlight the offending input. */
  field?: string;
}

export const ERROR_EXPLANATIONS: Record<string, ErrorExplanation> = {
  "0002": {
    plain: "The buyer's NTN or CNIC isn't a valid length. An NTN is 7 digits; a CNIC is 13 digits, with no dashes.",
    field: "buyerNTNCNIC",
  },
  "0003": { plain: "FBR didn't accept the document type.", field: "invoiceType" },
  "0005": { plain: "The invoice date isn't in the format FBR expects (YYYY-MM-DD).", field: "invoiceDate" },
  "0007": { plain: "FBR rejected this sale type for this invoice.", field: "saleType" },
  "0008": {
    plain:
      "Sales tax withheld at source must be either zero or exactly equal to the sales tax amount — nothing in between.",
    field: "salesTaxWithheldAtSource",
  },
  "0009": { plain: "The buyer's registration number is missing or invalid.", field: "buyerNTNCNIC" },
  "0010": { plain: "The buyer's business name is required.", field: "buyerBusinessName" },
  "0012": {
    plain: "The buyer's registration type is missing or doesn't match FBR's records. Try the 'Check buyer' button.",
    field: "buyerRegistrationType",
  },
  "0013": { plain: "The sale type is missing or not one FBR recognises.", field: "saleType" },
  "0018": { plain: "The sales tax amount is missing or invalid.", field: "salesTaxApplicable" },
  "0019": { plain: "The HS code is missing or invalid.", field: "hsCode" },
  "0020": { plain: "The tax rate is missing or invalid.", field: "rate" },
  "0021": { plain: "The sale value excluding sales tax is missing or invalid.", field: "valueSalesExcludingST" },
  "0022": { plain: "Sales tax withheld at source is invalid.", field: "salesTaxWithheldAtSource" },
  "0023": { plain: "The sales tax amount is invalid.", field: "salesTaxApplicable" },
  "0024": { plain: "Sales tax withheld at source is invalid.", field: "salesTaxWithheldAtSource" },
  "0031": { plain: "The sales tax amount doesn't add up for this sale type.", field: "salesTaxApplicable" },
  "0044": { plain: "The HS code is not valid.", field: "hsCode" },
  "0046": { plain: "The tax rate is missing. Pick a sale type so the rate can be looked up.", field: "rate" },
  "0050": { plain: "Sales tax withheld at source is invalid for this sale type.", field: "salesTaxWithheldAtSource" },
  "0052": {
    plain: "FBR rejected the HS code — it may not exist, or it may not be allowed for the sale type you picked.",
    field: "hsCode",
  },
  "0053": { plain: "The buyer's registration type doesn't match FBR's records.", field: "buyerRegistrationType" },
  "0055": { plain: "Sales tax withheld at source is invalid.", field: "salesTaxWithheldAtSource" },
  "0058": {
    plain: "The buyer and seller registration numbers are the same. FBR doesn't allow an invoice to yourself.",
    field: "buyerNTNCNIC",
  },
  "0073": {
    plain: "The seller's province isn't one FBR recognises. Fix it in Settings for this account.",
    field: "sellerProvince",
  },
  "0074": { plain: "The buyer's province (destination of supply) isn't one FBR recognises.", field: "buyerProvince" },
  "0077": { plain: "The SRO schedule number is invalid.", field: "sroScheduleNo" },
  "0078": { plain: "The SRO item serial number is invalid.", field: "sroItemSerialNo" },
  "0079": { plain: "A 5% rate isn't allowed once the sale value exceeds Rs. 20,000.", field: "rate" },
  "0080": { plain: "The further tax amount is invalid for this sale type.", field: "furtherTax" },
  "0082": { plain: "The seller's NTN/CNIC is invalid. Check it in Settings.", field: "sellerNTNCNIC" },
  "0083": { plain: "The seller's NTN/CNIC is invalid. Check it in Settings.", field: "sellerNTNCNIC" },
  "0085": {
    plain: "FBR wants a total sales value here. This normally applies only to PFAD — enter it manually.",
    field: "totalValues",
  },
  "0089": { plain: "The federal excise duty payable amount is invalid.", field: "fedPayable" },
  "0090": {
    plain: "FBR needs the fixed notified value or retail price for this item.",
    field: "fixedNotifiedValueOrRetailPrice",
  },
  "0091": { plain: "Extra tax must be empty for this sale type. Clear it.", field: "extraTax" },
  "0092": { plain: "FBR rejected this sale type.", field: "saleType" },
  "0093": { plain: "FBR rejected this sale type.", field: "saleType" },
  "0095": { plain: "This sale type requires an extra tax amount.", field: "extraTax" },
  "0096": { plain: "This HS code must be measured in KWH.", field: "uoM" },
  "0097": { plain: "This HS code must be measured in KG.", field: "uoM" },
  "0098": { plain: "The quantity is missing or invalid.", field: "quantity" },
  "0099": {
    plain: "The unit of measure isn't allowed for this HS code. Pick one from the list for this HS code.",
    field: "uoM",
  },
  "0101": { plain: "FBR rejected this sale type.", field: "saleType" },
  "0102": {
    plain:
      "For 3rd Schedule goods, tax is calculated on the retail price rather than the sale value. Enter the retail price and check the tax amount.",
    field: "fixedNotifiedValueOrRetailPrice",
  },
  "0104": {
    plain:
      "FBR recalculated the sales tax and got a different number. If this rate has a per-unit component (for example 'rupees 60 per kilogram'), that part has to be added by hand.",
    field: "salesTaxApplicable",
  },
  "0105": { plain: "The sales tax amount doesn't match what FBR expects.", field: "salesTaxApplicable" },
  "0106": { plain: "The buyer's NTN/CNIC is invalid.", field: "buyerNTNCNIC" },
  "0107": { plain: "The buyer's NTN/CNIC is invalid.", field: "buyerNTNCNIC" },
  "0108": { plain: "The seller's NTN/CNIC is invalid. Check it in Settings.", field: "sellerNTNCNIC" },
  "0164": { plain: "This HS code must be measured in KWH.", field: "uoM" },
  "0165": { plain: "This HS code must be measured in KG.", field: "uoM" },
  "0167": { plain: "The sale value excluding sales tax is invalid.", field: "valueSalesExcludingST" },
  "0175": {
    plain: "The fixed notified value or retail price is invalid.",
    field: "fixedNotifiedValueOrRetailPrice",
  },
  "0176": { plain: "Sales tax withheld at source is invalid.", field: "salesTaxWithheldAtSource" },
  "0177": { plain: "The further tax amount is invalid.", field: "furtherTax" },
  "0300": {
    plain: "One of the amounts isn't a valid number. Check the figures on the line item FBR named.",
  },
  "0401": {
    plain:
      "This account's token doesn't belong to the seller NTN on the invoice. Check that the right account is selected and that its token and NTN match in Settings.",
    field: "sellerNTNCNIC",
  },
  "0402": {
    plain: "FBR says there's no authorised token for the buyer's NTN/CNIC.",
    field: "buyerNTNCNIC",
  },
};

/**
 * Builds the message shown to the user. FBR's own wording is always included — our translation is
 * an addition, never a replacement, because an unrecognised code must still be actionable.
 */
export function explain(code: string | null, fbrMessage: string): { plain: string; field: string | null } {
  const known = code ? ERROR_EXPLANATIONS[code] : undefined;
  const fbrText = fbrMessage.trim();

  if (!known) {
    return {
      plain: fbrText || `FBR rejected the invoice${code ? ` with error ${code}` : ""} but gave no explanation.`,
      field: null,
    };
  }

  return {
    plain: fbrText ? `${known.plain} (FBR said: "${fbrText}")` : known.plain,
    field: known.field ?? null,
  };
}
