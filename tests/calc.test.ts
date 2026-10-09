import { describe, expect, test } from "bun:test";
import { classifyRate, computeLine, round2 } from "../src/core/calc.ts";
import type { SaleTypeRate } from "../src/core/types.ts";

const STANDARD_18: SaleTypeRate = { ratE_ID: 1, ratE_DESC: "18%", ratE_VALUE: 18 };
const ZERO_RATE: SaleTypeRate = { ratE_ID: 2, ratE_DESC: "0%", ratE_VALUE: 0 };

/**
 * A real compound rate from FBR's SaleTypeToRate reference data. `ratE_VALUE` is 18 — the Rs. 60
 * per kilogram exists only in the prose, so a percentage-only calculation under-reports the tax
 * and FBR rejects the invoice with error 0104.
 */
const COMPOUND: SaleTypeRate = {
  ratE_ID: 3,
  ratE_DESC: "18% along with rupees 60 per kilogram",
  ratE_VALUE: 18,
};

const STANDARD_SALE_TYPE = "Goods at standard rate (default)";

describe("round2", () => {
  test("rounds half away from zero, not to even", () => {
    // Banker's rounding would give 0.12 here. FBR recalculates and compares, so the choice of
    // rounding mode is a named assumption, not an implementation detail.
    expect(round2(0.125)).toBe(0.13);
    expect(round2(2.345)).toBe(2.35);
  });

  test("leaves exact values alone and never produces float dust", () => {
    expect(round2(1000)).toBe(1000);
    expect(round2(180.0)).toBe(180);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  test("handles negatives symmetrically", () => {
    expect(round2(-0.125)).toBe(-0.13);
  });
});

describe("classifyRate", () => {
  test("recognises a plain percentage", () => {
    expect(classifyRate("18%")).toBe("percentage");
    expect(classifyRate("0%")).toBe("percentage");
    expect(classifyRate(" 17.5 % ")).toBe("percentage");
  });

  test("recognises a percentage with an extra per-unit component as compound", () => {
    expect(classifyRate("18% along with rupees 60 per kilogram")).toBe("compound");
  });

  test("recognises a rate with no percentage at all", () => {
    expect(classifyRate("rupees 60 per kilogram")).toBe("non-percentage");
  });
});

describe("computeLine — the straightforward case", () => {
  test("computes value and tax for a standard-rate sale", () => {
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });

    expect(result.valueSalesExcludingST).toBe(1000);
    expect(result.salesTaxApplicable).toBe(180);
    expect(result.confidence).toBe("high");
    expect(result.warnings).toHaveLength(0);
  });

  test("passes FBR's rate description through verbatim rather than reformatting it", () => {
    const result = computeLine({
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.rate).toBe("18%");
  });

  test("handles a zero-rated sale without flagging uncertainty", () => {
    const result = computeLine({
      quantity: 5,
      unitPrice: 200,
      discount: 0,
      rate: ZERO_RATE,
      saleType: "Goods at zero-rate",
    });
    expect(result.valueSalesExcludingST).toBe(1000);
    expect(result.salesTaxApplicable).toBe(0);
    expect(result.confidence).toBe("high");
  });

  test("defaults totalValues to 0.00, matching every official sample", () => {
    // The spec calls this "Total Sales Value (Including Tax)" yet every sample sends 0.00 and
    // error 0085 scopes it to PFAD. Computing 1180 here risks a rejection, so we mirror the
    // samples and record the choice as an assumption. Flagged for sandbox probing.
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.totalValues).toBe(0);
    expect(result.assumptions.join(" ")).toMatch(/total/i);
  });

  test("rounds tax to two decimals", () => {
    const result = computeLine({
      quantity: 1,
      unitPrice: 1000.05,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.valueSalesExcludingST).toBe(1000.05);
    expect(result.salesTaxApplicable).toBe(180.01);
  });
});

describe("computeLine — discount", () => {
  test("taxes the value after discount and says so", () => {
    // FBR does not document whether discount precedes tax. We pick one, name it, and verify.
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 100,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.valueSalesExcludingST).toBe(900);
    expect(result.salesTaxApplicable).toBe(162);
    expect(result.assumptions.join(" ")).toMatch(/discount/i);
  });

  test("warns rather than going negative when the discount exceeds the line value", () => {
    const result = computeLine({
      quantity: 1,
      unitPrice: 100,
      discount: 500,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.valueSalesExcludingST).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/discount/i);
  });
});

describe("computeLine — rates it cannot fully compute", () => {
  test("flags a compound rate as low confidence and names the missing component", () => {
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: COMPOUND,
      saleType: STANDARD_SALE_TYPE,
    });

    // The percentage part is still computed — it is a useful starting point, not a guess.
    expect(result.salesTaxApplicable).toBe(180);
    expect(result.confidence).toBe("low");
    expect(result.warnings.join(" ")).toMatch(/per kilogram|per-unit|by hand/i);
  });

  test("flags a rate with no percentage at all and computes no tax", () => {
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: { ratE_ID: 9, ratE_DESC: "rupees 60 per kilogram", ratE_VALUE: 0 },
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.confidence).toBe("low");
    expect(result.salesTaxApplicable).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("computeLine — 3rd Schedule goods", () => {
  test("taxes the retail price rather than the sale value", () => {
    // Error 0102: "Calculated tax not matched in 3rd schedule". The base is
    // fixedNotifiedValueOrRetailPrice, not valueSalesExcludingST.
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: "3rd Schedule Goods",
      retailPrice: 150,
    });

    expect(result.valueSalesExcludingST).toBe(1000);
    expect(result.salesTaxApplicable).toBe(270); // 150 retail x 10 units x 18%
    expect(result.confidence).toBe("low");
  });

  test("warns when 3rd Schedule goods have no retail price entered", () => {
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: "3rd Schedule Goods",
    });
    expect(result.warnings.join(" ")).toMatch(/retail price/i);
    expect(result.confidence).toBe("low");
  });
});

describe("computeLine — fields that must never be inferred", () => {
  test("passes further tax and extra tax through untouched", () => {
    // Errors 0091 and 0095 are mutually exclusive per sale type and neither amount is derivable
    // from ratE_VALUE, so these are always explicit user input.
    const result = computeLine({
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
      furtherTax: 120,
      extraTax: 5,
      fedPayable: 7,
      salesTaxWithheldAtSource: 180,
    });

    expect(result.furtherTax).toBe(120);
    expect(result.extraTax).toBe(5);
    expect(result.fedPayable).toBe(7);
    expect(result.salesTaxWithheldAtSource).toBe(180);
    // Sales tax excludes further and extra tax, per the spec's own field description.
    expect(result.salesTaxApplicable).toBe(180);
  });

  test("defaults every optional amount to 0 rather than leaving it undefined", () => {
    // Error 0300 rejects malformed decimals, so these must be real zeros on the wire.
    const result = computeLine({
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.furtherTax).toBe(0);
    expect(result.extraTax).toBe(0);
    expect(result.fedPayable).toBe(0);
    expect(result.salesTaxWithheldAtSource).toBe(0);
    expect(result.fixedNotifiedValueOrRetailPrice).toBe(0);
  });
});

describe("computeLine — invalid input", () => {
  test("warns on a zero or negative quantity", () => {
    const result = computeLine({
      quantity: 0,
      unitPrice: 100,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.warnings.join(" ")).toMatch(/quantity/i);
  });

  test("warns on a negative unit price", () => {
    const result = computeLine({
      quantity: 1,
      unitPrice: -5,
      discount: 0,
      rate: STANDARD_18,
      saleType: STANDARD_SALE_TYPE,
    });
    expect(result.warnings.join(" ")).toMatch(/price/i);
  });
});
