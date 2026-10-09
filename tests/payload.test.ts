import { describe, expect, test } from "bun:test";
import { buildInvoicePayload, pakistanDate } from "../src/core/payload.ts";
import { HS_CODE_PATTERN } from "../src/core/types.ts";
import type { Account } from "../src/core/types.ts";

const ACCOUNT: Account = {
  id: "acct-1",
  label: "Acme Traders",
  sellerNTNCNIC: "0786909",
  sellerBusinessName: "Company 8",
  sellerProvince: "Sindh",
  sellerAddress: "Karachi",
  sandboxToken: "sandbox-token",
  productionToken: "production-token",
  eligibleScenarios: ["SN001", "SN002"],
};

const BUYER = {
  ntncnic: "1000000000000",
  businessName: "FERTILIZER MANUFAC IRS NEW",
  province: "Sindh",
  address: "Karachi",
  registrationType: "Unregistered" as const,
};

const ITEM = {
  hsCode: "0101.2100",
  productDescription: "product Description",
  rate: "18%",
  uoM: "Numbers, pieces, units",
  quantity: 1,
  totalValues: 0,
  valueSalesExcludingST: 1000,
  fixedNotifiedValueOrRetailPrice: 0,
  salesTaxApplicable: 180,
  salesTaxWithheldAtSource: 0,
  extraTax: 0,
  furtherTax: 120,
  sroScheduleNo: "",
  fedPayable: 0,
  discount: 0,
  saleType: "Goods at standard rate (default)",
  sroItemSerialNo: "",
};

function base(env: "sandbox" | "production") {
  return {
    env,
    account: ACCOUNT,
    buyer: BUYER,
    invoiceDate: "2025-04-21",
    items: [ITEM],
  };
}

describe("buildInvoicePayload", () => {
  test("produces every field the spec's sample sends, with the spec's exact casing", () => {
    const payload = buildInvoicePayload({ ...base("sandbox"), scenarioId: "SN001" });

    expect(Object.keys(payload).sort()).toEqual(
      [
        "buyerAddress",
        "buyerBusinessName",
        "buyerNTNCNIC",
        "buyerProvince",
        "buyerRegistrationType",
        "invoiceDate",
        "invoiceRefNo",
        "invoiceType",
        "items",
        "scenarioId",
        "sellerAddress",
        "sellerBusinessName",
        "sellerNTNCNIC",
        "sellerProvince",
      ].sort(),
    );
    expect(payload.invoiceType).toBe("Sale Invoice");
  });

  test("takes the whole seller block from the account, never from the form", () => {
    const payload = buildInvoicePayload(base("sandbox"));
    expect(payload.sellerNTNCNIC).toBe("0786909");
    expect(payload.sellerBusinessName).toBe("Company 8");
    expect(payload.sellerProvince).toBe("Sindh");
    expect(payload.sellerAddress).toBe("Karachi");
  });

  test("keeps the item's rate, UoM and sale type strings verbatim", () => {
    const payload = buildInvoicePayload(base("sandbox"));
    const item = payload.items[0]!;
    expect(item.rate).toBe("18%");
    expect(item.uoM).toBe("Numbers, pieces, units");
    expect(item.saleType).toBe("Goods at standard rate (default)");
  });
});

describe("buildInvoicePayload — scenarioId", () => {
  test("includes scenarioId in sandbox", () => {
    const payload = buildInvoicePayload({ ...base("sandbox"), scenarioId: "SN001" });
    expect(payload.scenarioId).toBe("SN001");
  });

  test("omits the scenarioId KEY entirely in production, rather than blanking it", () => {
    // FBR's production samples have no scenarioId at all. Sending "" is not the same as sending
    // nothing, so this asserts on key presence, not on the value.
    const payload = buildInvoicePayload({ ...base("production"), scenarioId: "SN001" });
    expect("scenarioId" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("scenarioId");
  });

  test("omits the key in sandbox too when no scenario was chosen", () => {
    const payload = buildInvoicePayload(base("sandbox"));
    expect("scenarioId" in payload).toBe(false);
  });
});

describe("buildInvoicePayload — invoiceRefNo", () => {
  test("sends an empty invoiceRefNo for a sale invoice", () => {
    const payload = buildInvoicePayload(base("sandbox"));
    expect(payload.invoiceRefNo).toBe("");
  });

  test("never puts the user's own invoice number in invoiceRefNo", () => {
    // invoiceRefNo is FBR's IRN of an ORIGINAL invoice, used only by debit notes. Putting the
    // user's internal reference there earns error 0057, "Reference Invoice does not exist".
    // The internal reference is kept in the local log instead.
    const payload = buildInvoicePayload({
      ...base("sandbox"),
      internalInvoiceNumber: "ACME-2026-0001",
    });
    expect(payload.invoiceRefNo).toBe("");
    expect(JSON.stringify(payload)).not.toContain("ACME-2026-0001");
  });
});

describe("buildInvoicePayload — serialisation", () => {
  test("sends buyerNTNCNIC as a string", () => {
    // The spec's field table shows it unquoted but its sample JSON quotes it. The sample wins.
    const payload = buildInvoicePayload(base("sandbox"));
    expect(typeof payload.buyerNTNCNIC).toBe("string");
    expect(JSON.stringify(payload)).toContain('"buyerNTNCNIC":"1000000000000"');
  });

  test("emits no null or undefined anywhere, so error 0300 can't fire on a blank amount", () => {
    const payload = buildInvoicePayload({
      ...base("sandbox"),
      items: [{ ...ITEM, furtherTax: 0, extraTax: 0 }],
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain("null");
    expect(json).not.toContain("undefined");
  });

  test("sends every numeric item field as a number, not a string", () => {
    const payload = buildInvoicePayload(base("sandbox"));
    const item = payload.items[0]!;
    for (const field of [
      "quantity",
      "totalValues",
      "valueSalesExcludingST",
      "fixedNotifiedValueOrRetailPrice",
      "salesTaxApplicable",
      "salesTaxWithheldAtSource",
      "extraTax",
      "furtherTax",
      "fedPayable",
      "discount",
    ] as const) {
      expect(typeof item[field]).toBe("number");
    }
  });

  test("allows a blank buyer NTN/CNIC for an unregistered buyer", () => {
    const payload = buildInvoicePayload({
      ...base("sandbox"),
      buyer: { ...BUYER, ntncnic: "", registrationType: "Unregistered" },
    });
    expect(payload.buyerNTNCNIC).toBe("");
  });

  test("trims stray whitespace out of identifiers", () => {
    const payload = buildInvoicePayload({
      ...base("sandbox"),
      buyer: { ...BUYER, ntncnic: " 1000000000000 " },
    });
    expect(payload.buyerNTNCNIC).toBe("1000000000000");
  });

  test("keeps item order, so FBR's itemSNo lines up with the form", () => {
    const payload = buildInvoicePayload({
      ...base("sandbox"),
      items: [
        { ...ITEM, productDescription: "first" },
        { ...ITEM, productDescription: "second" },
      ],
    });
    expect(payload.items.map((i) => i.productDescription)).toEqual(["first", "second"]);
  });
});

describe("pakistanDate", () => {
  test("uses Pakistan's calendar date, not UTC's", () => {
    // 19:30 UTC is already the next day in Pakistan (UTC+5). Filing on the wrong day matters:
    // FBR only allows corrections back 3 days.
    expect(pakistanDate(new Date("2026-10-09T19:30:00Z"))).toBe("2026-10-10");
  });

  test("stays on the same day well inside Pakistan's working hours", () => {
    expect(pakistanDate(new Date("2026-10-09T06:00:00Z"))).toBe("2026-10-09");
  });

  test("formats as YYYY-MM-DD with zero padding", () => {
    expect(pakistanDate(new Date("2026-01-05T06:00:00Z"))).toBe("2026-01-05");
  });
});

describe("HS_CODE_PATTERN", () => {
  test("accepts the shape every real FBR code uses", () => {
    // Verified against all 7,809 codes the live itemdesccode endpoint returns.
    for (const code of ["2942.0000", "2931.9090", "3808.9400", "8421.2100", "0101.2100"]) {
      expect(HS_CODE_PATTERN.test(code)).toBe(true);
    }
  });

  test("rejects the half-typed values that used to reach FBR", () => {
    for (const partial of ["", "q", "2", "29", "294", "2942", "2942.", "2942.00", "29420000"]) {
      expect(HS_CODE_PATTERN.test(partial)).toBe(false);
    }
  });
});
