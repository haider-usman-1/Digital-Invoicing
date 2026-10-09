/**
 * The 28 sandbox scenarios, from PRAL Technical Specification v1.12 section 9.
 *
 * What these are: before FBR issues a production token, an account must successfully POST one
 * invoice for each scenario applicable to its declared Business Nature and Sector. Passing them is
 * the thing standing between a new registration and being able to file real invoices.
 *
 * `saleType` is fixed per scenario by FBR's own table, which is why the scenario screen can prefill
 * it — that is the single most useful thing this table buys us.
 *
 * What is deliberately NOT here: the Business-Nature x Sector eligibility matrix from section 10.
 * That matrix has duplicate entries (SN008 listed twice in several rows) and skipped row numbers,
 * and the IRIS dashboard's "Eligible Scenarios" tile is the authoritative live list for a given
 * registration. Each account stores its own eligible list, taken from there.
 */

export interface Scenario {
  id: string;
  description: string;
  /** The exact `saleType` FBR expects for this scenario. */
  saleType: string;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: "SN001", description: "Goods at standard rate to registered buyers", saleType: "Goods at Standard Rate (default)" },
  { id: "SN002", description: "Goods at standard rate to unregistered buyers", saleType: "Goods at Standard Rate (default)" },
  { id: "SN003", description: "Sale of Steel (Melted and Re-Rolled)", saleType: "Steel Melting and re-rolling" },
  { id: "SN004", description: "Sale by Ship Breakers", saleType: "Ship breaking" },
  { id: "SN005", description: "Reduced rate sale", saleType: "Goods at Reduced Rate" },
  { id: "SN006", description: "Exempt goods sale", saleType: "Exempt Goods" },
  { id: "SN007", description: "Zero rated sale", saleType: "Goods at zero-rate" },
  { id: "SN008", description: "Sale of 3rd schedule goods", saleType: "3rd Schedule Goods" },
  { id: "SN009", description: "Cotton Spinners purchase from Cotton Ginners (Textile Sector)", saleType: "Cotton Ginners" },
  { id: "SN010", description: "Telecom services rendered or provided", saleType: "Telecommunication services" },
  { id: "SN011", description: "Toll Manufacturing sale by Steel sector", saleType: "Toll Manufacturing" },
  { id: "SN012", description: "Sale of Petroleum products", saleType: "Petroleum Products" },
  { id: "SN013", description: "Electricity Supply to Retailers", saleType: "Electricity Supply to Retailers" },
  { id: "SN014", description: "Sale of Gas to CNG stations", saleType: "Gas to CNG stations" },
  { id: "SN015", description: "Sale of mobile phones", saleType: "Mobile Phones" },
  { id: "SN016", description: "Processing / Conversion of Goods", saleType: "Processing/ Conversion of Goods" },
  { id: "SN017", description: "Sale of Goods where FED is charged in ST mode", saleType: "Goods (FED in ST Mode)" },
  { id: "SN018", description: "Services rendered or provided where FED is charged in ST mode", saleType: "Services (FED in ST Mode)" },
  { id: "SN019", description: "Services rendered or provided", saleType: "Services" },
  { id: "SN020", description: "Sale of Electric Vehicles", saleType: "Electric Vehicle" },
  { id: "SN021", description: "Sale of Cement /Concrete Block", saleType: "Cement /Concrete Block" },
  { id: "SN022", description: "Sale of Potassium Chlorate", saleType: "Potassium Chlorate" },
  { id: "SN023", description: "Sale of CNG", saleType: "CNG Sales" },
  { id: "SN024", description: "Goods sold that are listed in SRO 297(1)/2023", saleType: "Goods as per SRO.297(|)/2023" },
  {
    id: "SN025",
    description: "Drugs sold at fixed ST rate under serial 81 of Eighth Schedule Table 1",
    saleType: "Non-Adjustable Supplies",
  },
  { id: "SN026", description: "Sale to End Consumer by retailers", saleType: "Goods at Standard Rate (default)" },
  { id: "SN027", description: "Sale to End Consumer by retailers", saleType: "3rd Schedule Goods" },
  { id: "SN028", description: "Sale to End Consumer by retailers", saleType: "Goods at Reduced Rate" },
] as const;

const BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

export function findScenario(id: string): Scenario | undefined {
  return BY_ID.get(id.trim().toUpperCase());
}

/**
 * Scenarios whose buyer must be unregistered.
 *
 * SN002 is "to unregistered buyers" by definition, and SN026-SN028 are retail sales to an end
 * consumer. Prefilling the wrong registration type here earns error 0012 or 0053.
 */
const UNREGISTERED_BUYER_SCENARIOS = new Set(["SN002", "SN026", "SN027", "SN028"]);

export function expectedBuyerRegistrationType(scenarioId: string): "Registered" | "Unregistered" {
  return UNREGISTERED_BUYER_SCENARIOS.has(scenarioId.trim().toUpperCase())
    ? "Unregistered"
    : "Registered";
}

/**
 * FBR's note on section 9, worth surfacing in the UI: scenarios 26, 27 and 28 apply only to
 * registrations with a retailer sales-tax profile.
 */
export const RETAILER_ONLY_SCENARIOS = new Set(["SN026", "SN027", "SN028"]);
