/**
 * Pure tax calculation for a single invoice line.
 *
 * FBR recalculates every amount server-side and rejects mismatches (error 0104 for percentage
 * tax, 0102 for 3rd Schedule goods). Several of the inputs it checks against are not derivable
 * from the reference data:
 *
 *   - Compound rates such as "18% along with rupees 60 per kilogram" expose only `ratE_VALUE: 18`.
 *     The per-kilogram amount exists solely in the prose, and parsing prose into money is not
 *     something worth being clever about.
 *   - 3rd Schedule goods are assessed on the retail price, not the sale value.
 *   - `furtherTax` and `extraTax` depend on the sale type in ways FBR documents only through
 *     mutually exclusive error codes (0091 "must be empty" vs 0095 "please provide").
 *
 * So this module computes what it can, states what it assumed, and says plainly when the user has
 * to finish the job by hand. It never guesses silently — a confident wrong number costs a rejected
 * filing, while an honest warning costs one edit.
 */

import type { SaleTypeRate } from "./types.ts";

export type RateKind = "percentage" | "compound" | "non-percentage";

/**
 * How the user drove the line's money.
 *
 * Both directions are first-class because both are how people actually work: some invoices are
 * naturally "200 units at Rs. 125", others are "Rs. 25,000 of rice". Whichever the user typed is
 * authoritative, and the other is derived for display only — never round-tripped. Back-solving a
 * unit price from a value and recomputing would drift (25,000 over 3 units gives 8333.33, which
 * recomputes to 24,999.99), and filing a paisa off what was typed is how FBR's own recalculation
 * produces error 0104.
 */
export type LineAmount =
  | { basis: "unitPrice"; unitPrice: number }
  /** The sales value excluding tax, taken as already net of any discount. */
  | { basis: "value"; valueSalesExcludingST: number };

export interface LineInput {
  quantity: number;
  amount: LineAmount;
  /** Absolute discount on the line, not a percentage. */
  discount: number;
  /** The chosen row from the SaleTypeToRate reference endpoint. */
  rate: SaleTypeRate;
  /** `transactioN_DESC`, needed to recognise sale types with a different tax base. */
  saleType: string;
  /** Retail price per unit — required for 3rd Schedule goods. */
  retailPrice?: number;
  extraTax?: number;
  furtherTax?: number;
  fedPayable?: number;
  salesTaxWithheldAtSource?: number;
}

export interface ComputedLine {
  valueSalesExcludingST: number;
  /**
   * Unit price for the line: as entered when the user drove it that way, otherwise derived from
   * the value. Display only — it is never sent to FBR, which has no such field.
   */
  unitPrice: number;
  salesTaxApplicable: number;
  totalValues: number;
  fixedNotifiedValueOrRetailPrice: number;
  extraTax: number;
  furtherTax: number;
  fedPayable: number;
  salesTaxWithheldAtSource: number;
  discount: number;
  /** FBR's own rate description, passed through verbatim — it is what goes on the wire. */
  rate: string;
  /** "low" means the user must check or complete the amounts before submitting. */
  confidence: "high" | "low";
  /** Undocumented choices we made, surfaced so they can be verified against sandbox. */
  assumptions: string[];
  /** Things the user must act on. */
  warnings: string[];
}

const PLAIN_PERCENTAGE = /^\d+(?:\.\d+)?\s*%$/;

/**
 * Rounds half away from zero at 2 decimal places.
 *
 * The two-stage approach is deliberate: `2.345` is stored as 2.3449999... in binary, so a naive
 * `Math.round(n * 100)` would give 2.34. Re-reading at 12 significant digits collapses that
 * representation error before rounding. FBR's own rounding mode is undocumented — half-up is an
 * assumption recorded on every result.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  const scaled = Number((Math.abs(value) * 100).toPrecision(12));
  return (sign * Math.floor(scaled + 0.5)) / 100;
}

export function classifyRate(description: string): RateKind {
  const trimmed = description.trim();
  if (PLAIN_PERCENTAGE.test(trimmed)) return "percentage";
  return trimmed.includes("%") ? "compound" : "non-percentage";
}

function isThirdSchedule(saleType: string): boolean {
  return /3rd\s*schedule/i.test(saleType);
}

export function computeLine(input: LineInput): ComputedLine {
  const warnings: string[] = [];
  const assumptions: string[] = [
    "Sales tax is calculated on the value after discount. FBR doesn't document whether discount comes before or after tax.",
    "Total value including tax is sent as 0.00, matching every official FBR sample (FBR's error 0085 scopes that field to PFAD).",
    "Amounts are rounded half-up to 2 decimal places. FBR recalculates and compares, and its rounding mode isn't published.",
  ];

  const quantity = input.quantity;
  const discount = round2(Math.max(input.discount, 0));
  const retailPrice = round2(Math.max(input.retailPrice ?? 0, 0));

  if (!(quantity > 0)) warnings.push("Quantity must be greater than zero.");
  if (input.discount < 0) warnings.push("The discount can't be negative.");

  let valueSalesExcludingST: number;
  let unitPrice: number;

  if (input.amount.basis === "unitPrice") {
    if (input.amount.unitPrice < 0) warnings.push("The unit price can't be negative.");

    unitPrice = round2(input.amount.unitPrice);
    valueSalesExcludingST = round2(round2(quantity * input.amount.unitPrice) - discount);

    if (valueSalesExcludingST < 0) {
      warnings.push("The discount is larger than the line value, which would make the sale negative.");
      valueSalesExcludingST = 0;
    }
  } else {
    if (input.amount.valueSalesExcludingST < 0) {
      warnings.push("The value excluding sales tax can't be negative.");
    }

    // Taken exactly as typed. FBR models value and discount as separate fields, so the discount is
    // reported alongside rather than deducted again.
    valueSalesExcludingST = round2(Math.max(input.amount.valueSalesExcludingST, 0));
    assumptions.push(
      "The value you typed is treated as already net of discount, and the discount is reported to FBR in its own field.",
    );
    unitPrice = quantity > 0 ? round2(valueSalesExcludingST / quantity) : 0;
  }

  const rateKind = classifyRate(input.rate.ratE_DESC);
  const thirdSchedule = isThirdSchedule(input.saleType);

  // 3rd Schedule goods are taxed on retail price rather than sale value (error 0102). Whether FBR
  // expects retail-price-per-unit times quantity is an inference, hence the low confidence.
  let taxBase = valueSalesExcludingST;
  if (thirdSchedule) {
    if (retailPrice > 0) {
      taxBase = round2(retailPrice * Math.max(quantity, 0));
      assumptions.push(
        "For 3rd Schedule goods the tax base is retail price x quantity, and tax is charged on that instead of the sale value.",
      );
    } else {
      warnings.push(
        "3rd Schedule goods are taxed on the retail price, not the sale value. Enter the retail price for this item.",
      );
    }
  }

  let salesTaxApplicable = 0;
  if (rateKind === "non-percentage") {
    warnings.push(
      `The rate "${input.rate.ratE_DESC}" isn't a percentage, so the sales tax can't be worked out automatically. Enter the tax amount by hand.`,
    );
  } else {
    salesTaxApplicable = round2((taxBase * input.rate.ratE_VALUE) / 100);
    if (rateKind === "compound") {
      warnings.push(
        `The rate "${input.rate.ratE_DESC}" has a per-unit component on top of the percentage. Only the ${input.rate.ratE_VALUE}% part has been calculated — add the rest by hand or FBR will reject the invoice.`,
      );
    }
  }

  const confidence: "high" | "low" = rateKind !== "percentage" || thirdSchedule ? "low" : "high";

  return {
    valueSalesExcludingST,
    unitPrice,
    salesTaxApplicable,
    // Mirrors FBR's samples rather than the field's name. See the assumption above.
    totalValues: 0,
    fixedNotifiedValueOrRetailPrice: retailPrice,
    // Never inferred — FBR's rules for these are sale-type specific and only partly documented.
    extraTax: round2(input.extraTax ?? 0),
    furtherTax: round2(input.furtherTax ?? 0),
    fedPayable: round2(input.fedPayable ?? 0),
    salesTaxWithheldAtSource: round2(input.salesTaxWithheldAtSource ?? 0),
    discount,
    rate: input.rate.ratE_DESC,
    confidence,
    assumptions,
    warnings,
  };
}
