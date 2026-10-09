/**
 * Ready-to-post starting points for each sandbox scenario.
 *
 * The point of the scenario screen is that a scenario should be one click away from being filed.
 * Prefilling only the sale type saves nobody anything: HS code, unit of measure, rate, quantity,
 * value and the buyer all still have to be right, and FBR validates the combinations server-side.
 *
 * HONEST LIMITATION: these defaults are not verified against FBR. Nobody can verify them without a
 * sandbox token, and FBR enforces HS code / sale type / UoM / rate agreement with errors 0052
 * ("Provide proper HS Code"), 0099 ("UOM must be according to given HS Code") and 0101. So each
 * template is a best guess, and `verify` says what to check first when one is rejected.
 *
 * That is acceptable only because templates are editable and savable: fix a scenario once on the
 * first account and every later account inherits the correction. See `saveTemplate` in
 * src/server/templates.ts.
 *
 * Buyer defaults come from FBR's own documentation samples, per the user's choice. The registered
 * NTN in particular is a documentation example, not a known-active taxpayer — scenarios needing a
 * registered buyer will fail with error 0012 or 0053 until it is replaced with a real one.
 */

import { expectedBuyerRegistrationType } from "./scenarios.ts";
import type { BuyerRegistrationType } from "./types.ts";

export interface TemplateBuyer {
  ntncnic: string;
  businessName: string;
  province: string;
  address: string;
  registrationType: BuyerRegistrationType;
}

export interface TemplateItem {
  hsCode: string;
  productDescription: string;
  uoM: string;
  quantity: number;
  /** Lines are seeded by value rather than unit price, matching how invoices are entered here. */
  valueSalesExcludingST: number;
  /** Matched against the live SaleTypeToRate list; sent verbatim if there is no match. */
  rateDesc: string;
  retailPrice?: number;
  furtherTax?: number;
  extraTax?: number;
  fedPayable?: number;
  salesTaxWithheldAtSource?: number;
}

export interface ScenarioTemplate {
  buyer: TemplateBuyer;
  item: TemplateItem;
  /** What to check first if FBR rejects this template. Shown in the UI. */
  verify?: string;
}

/** FBR's unregistered-buyer sample, used verbatim. */
const UNREGISTERED_BUYER: TemplateBuyer = {
  ntncnic: "1000000000000",
  businessName: "FERTILIZER MANUFAC IRS NEW",
  province: "Sindh",
  address: "Karachi",
  registrationType: "Unregistered",
};

/**
 * A registration number that appears in FBR's documentation examples.
 *
 * Almost certainly NOT an active registered taxpayer, so every scenario using it needs this
 * replaced before it will pass. Called out in `verify` on each affected template.
 */
const REGISTERED_BUYER: TemplateBuyer = {
  ntncnic: "0788762",
  businessName: "Registered Buyer",
  province: "Punjab",
  address: "Lahore",
  registrationType: "Registered",
};

const REPLACE_BUYER =
  "The buyer NTN is from FBR's documentation, not a real registered taxpayer. Replace it with a genuinely registered NTN (use the Check button) or FBR returns error 0012 / 0053.";

const CHECK_HS = "If FBR rejects the HS code or unit of measure, pick valid ones from the lists and save this back as the template.";

function buyerFor(scenarioId: string): TemplateBuyer {
  return expectedBuyerRegistrationType(scenarioId) === "Registered" ? REGISTERED_BUYER : UNREGISTERED_BUYER;
}

/**
 * Per-scenario item defaults.
 *
 * Where a scenario names a commodity the HS code follows from it directly, which is the case for
 * most of them. The generic ones (standard rate, reduced rate, exempt) are the weakest guesses.
 */
const ITEMS: Record<string, TemplateItem & { verify?: string }> = {
  SN001: {
    hsCode: "1006.3010",
    productDescription: "Basmati rice, semi-milled or wholly milled",
    uoM: "KG",
    quantity: 100,
    valueSalesExcludingST: 25000,
    rateDesc: "18%",
    verify: `${REPLACE_BUYER} ${CHECK_HS}`,
  },
  SN002: {
    hsCode: "1006.3010",
    productDescription: "Basmati rice, semi-milled or wholly milled",
    uoM: "KG",
    quantity: 100,
    valueSalesExcludingST: 25000,
    rateDesc: "18%",
    // Supplies to unregistered buyers often attract further tax. FBR says which with error 0095,
    // so this starts at zero rather than guessing a percentage that would be rejected.
    verify:
      "Sales to unregistered buyers may need further tax. If FBR returns error 0095 or 0080, enter the amount it expects and save this back as the template.",
  },
  SN003: {
    hsCode: "7213.1000",
    productDescription: "Bars and rods, hot-rolled, of iron or non-alloy steel",
    uoM: "KG",
    quantity: 1000,
    valueSalesExcludingST: 250000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN004: {
    hsCode: "8908.0000",
    productDescription: "Vessels and other floating structures for breaking up",
    uoM: "KG",
    quantity: 1000,
    valueSalesExcludingST: 150000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN005: {
    hsCode: "1101.0010",
    productDescription: "Wheat flour",
    uoM: "KG",
    quantity: 500,
    valueSalesExcludingST: 50000,
    rateDesc: "5%",
    verify: `The reduced rate varies by commodity. Pick the rate FBR lists for this sale type. ${CHECK_HS}`,
  },
  SN006: {
    hsCode: "0401.2000",
    productDescription: "Milk, not concentrated",
    uoM: "Litre",
    quantity: 200,
    valueSalesExcludingST: 40000,
    rateDesc: "0%",
    verify: `Exempt supplies may need a specific rate entry rather than 0%. ${CHECK_HS}`,
  },
  SN007: {
    hsCode: "5208.1100",
    productDescription: "Plain weave cotton fabric, unbleached",
    uoM: "Square Metre",
    quantity: 500,
    valueSalesExcludingST: 125000,
    rateDesc: "0%",
    verify: CHECK_HS,
  },
  SN008: {
    hsCode: "3401.1900",
    productDescription: "Soap in bars or cakes for toilet use",
    uoM: "KG",
    quantity: 200,
    valueSalesExcludingST: 60000,
    rateDesc: "18%",
    // 3rd Schedule goods are assessed on retail price, not sale value (error 0102).
    retailPrice: 350,
    verify: `3rd Schedule goods are taxed on the retail price per unit, not the sale value. Check that figure first. ${CHECK_HS}`,
  },
  SN009: {
    hsCode: "5201.0000",
    productDescription: "Cotton, not carded or combed",
    uoM: "KG",
    quantity: 1000,
    valueSalesExcludingST: 200000,
    rateDesc: "18%",
    verify: `${REPLACE_BUYER} This scenario is a PURCHASE from a cotton ginner, so the counterparty is the ginner. ${CHECK_HS}`,
  },
  SN010: {
    hsCode: "9812.1000",
    productDescription: "Telecommunication services",
    uoM: "Numbers, pieces, units",
    quantity: 1,
    valueSalesExcludingST: 100000,
    rateDesc: "19.5%",
    verify: `Telecom is rated provincially and the rate differs by province. Pick the one FBR lists. ${CHECK_HS}`,
  },
  SN011: {
    hsCode: "7213.1000",
    productDescription: "Toll manufacturing of steel bars",
    uoM: "KG",
    quantity: 1000,
    valueSalesExcludingST: 100000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN012: {
    hsCode: "2710.1210",
    productDescription: "Motor spirit (petrol)",
    uoM: "Litre",
    quantity: 1000,
    valueSalesExcludingST: 250000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN013: {
    hsCode: "2716.0000",
    productDescription: "Electrical energy",
    // FBR requires KWH for electricity HS codes (errors 0096 / 0164).
    uoM: "KWH",
    quantity: 10000,
    valueSalesExcludingST: 300000,
    rateDesc: "18%",
    verify: `${REPLACE_BUYER} Electricity must be measured in KWH.`,
  },
  SN014: {
    hsCode: "2711.2100",
    productDescription: "Natural gas in gaseous state",
    uoM: "MMBTU",
    quantity: 100,
    valueSalesExcludingST: 150000,
    rateDesc: "18%",
    verify: `${REPLACE_BUYER} If MMBTU is rejected, pick the unit FBR lists for this HS code.`,
  },
  SN015: {
    hsCode: "8517.1210",
    productDescription: "Cellular mobile phone",
    uoM: "Numbers, pieces, units",
    quantity: 10,
    valueSalesExcludingST: 500000,
    rateDesc: "18%",
    verify: `Mobile phones are taxed in bands by value. Pick the rate FBR lists. ${CHECK_HS}`,
  },
  SN016: {
    hsCode: "9821.0000",
    productDescription: "Processing and conversion of goods",
    uoM: "KG",
    quantity: 500,
    valueSalesExcludingST: 75000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN017: {
    hsCode: "2202.1010",
    productDescription: "Aerated waters, flavoured",
    uoM: "Litre",
    quantity: 500,
    valueSalesExcludingST: 100000,
    rateDesc: "18%",
    // FED charged in sales tax mode, so the FED field is in play (error 0089).
    verify: `FED is charged in sales tax mode here, so FBR may require a FED payable amount. ${CHECK_HS}`,
  },
  SN018: {
    hsCode: "9814.2000",
    productDescription: "Services where FED is charged in sales tax mode",
    uoM: "Numbers, pieces, units",
    quantity: 1,
    valueSalesExcludingST: 100000,
    rateDesc: "18%",
    verify: `FED is charged in sales tax mode here, so FBR may require a FED payable amount. ${CHECK_HS}`,
  },
  SN019: {
    hsCode: "9815.4000",
    productDescription: "Services rendered",
    uoM: "Numbers, pieces, units",
    quantity: 1,
    valueSalesExcludingST: 100000,
    rateDesc: "16%",
    verify: `Services are rated provincially; the rate and HS heading both depend on the service. ${CHECK_HS}`,
  },
  SN020: {
    hsCode: "8703.8000",
    productDescription: "Motor car with electric motor for propulsion",
    uoM: "Numbers, pieces, units",
    quantity: 1,
    valueSalesExcludingST: 3000000,
    rateDesc: "1%",
    verify: `Electric vehicles have a concessionary rate. Pick the one FBR lists. ${CHECK_HS}`,
  },
  SN021: {
    hsCode: "2523.2910",
    productDescription: "Portland cement",
    uoM: "KG",
    quantity: 5000,
    valueSalesExcludingST: 200000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN022: {
    hsCode: "2829.1910",
    productDescription: "Potassium chlorate",
    uoM: "KG",
    quantity: 100,
    valueSalesExcludingST: 50000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN023: {
    hsCode: "2711.2100",
    productDescription: "Compressed natural gas",
    uoM: "KG",
    quantity: 500,
    valueSalesExcludingST: 100000,
    rateDesc: "18%",
    verify: CHECK_HS,
  },
  SN024: {
    hsCode: "8432.1010",
    productDescription: "Agricultural machinery listed in SRO 297(I)/2023",
    uoM: "Numbers, pieces, units",
    quantity: 2,
    valueSalesExcludingST: 150000,
    rateDesc: "18%",
    verify: `This scenario needs goods actually listed in SRO 297(I)/2023, and FBR may require the SRO fields (not yet supported — see docs/ROADMAP.md). ${CHECK_HS}`,
  },
  SN025: {
    hsCode: "3004.9099",
    productDescription: "Medicament for retail sale",
    uoM: "Numbers, pieces, units",
    quantity: 100,
    valueSalesExcludingST: 50000,
    rateDesc: "1%",
    verify: `Drugs under serial 81 of the Eighth Schedule have a fixed rate. Pick the one FBR lists. ${CHECK_HS}`,
  },
  SN026: {
    hsCode: "1006.3010",
    productDescription: "Basmati rice, retail sale to end consumer",
    uoM: "KG",
    quantity: 5,
    valueSalesExcludingST: 1500,
    rateDesc: "18%",
    verify: "Only applies if this registration has a retailer sales-tax profile.",
  },
  SN027: {
    hsCode: "3401.1900",
    productDescription: "Soap, retail sale to end consumer",
    uoM: "KG",
    quantity: 2,
    valueSalesExcludingST: 700,
    rateDesc: "18%",
    retailPrice: 350,
    verify:
      "Only applies if this registration has a retailer sales-tax profile. 3rd Schedule goods are taxed on retail price.",
  },
  SN028: {
    hsCode: "1101.0010",
    productDescription: "Wheat flour, retail sale to end consumer",
    uoM: "KG",
    quantity: 10,
    valueSalesExcludingST: 1000,
    rateDesc: "5%",
    verify: "Only applies if this registration has a retailer sales-tax profile.",
  },
};

/** A fallback so a scenario we have no entry for still opens a usable form. */
const GENERIC_ITEM: TemplateItem = {
  hsCode: "",
  productDescription: "",
  uoM: "",
  quantity: 1,
  valueSalesExcludingST: 0,
  rateDesc: "",
};

export function defaultTemplate(scenarioId: string): ScenarioTemplate {
  const id = scenarioId.trim().toUpperCase();
  const entry = ITEMS[id];
  if (!entry) {
    return {
      buyer: buyerFor(id),
      item: { ...GENERIC_ITEM },
      verify: "No built-in template for this scenario yet. Fill it in once and save it back.",
    };
  }

  const { verify, ...item } = entry;
  return {
    buyer: buyerFor(id),
    item,
    ...(verify ? { verify } : {}),
  };
}

export const DEFAULT_TEMPLATES: Record<string, ScenarioTemplate> = Object.fromEntries(
  Object.keys(ITEMS).map((id) => [id, defaultTemplate(id)]),
);
