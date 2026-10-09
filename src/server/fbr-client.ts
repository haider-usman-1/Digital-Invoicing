/**
 * Typed wrapper over the FBR Digital Invoicing API.
 *
 * Two things here are load-bearing:
 *
 * 1. Transport outcomes distinguish "definitely not filed" from "we genuinely don't know". FBR has
 *    no idempotency key and performs no retries, so a timeout on a POST means the invoice may or
 *    may not be on file. Collapsing that into a generic error would invite a duplicate filing.
 *    A 401 is safe to call "not filed" — the gateway rejected it before processing.
 *
 * 2. Mock mode. The entire UI is developable and testable against canned responses with no network
 *    and no real token, which matters because several of FBR's behaviours are undocumented and the
 *    user's sandbox tokens arrive later than the code does.
 */

import { BUYER_ENDPOINTS, REFERENCE_ENDPOINTS, invoiceUrl, referenceDateFormat } from "../core/endpoints.ts";
import type {
  Env,
  FbrInvoicePayload,
  FbrInvoiceResponse,
  HsCode,
  Province,
  RegistrationTypeResponse,
  SaleTypeRate,
  TransactionType,
  UnitOfMeasure,
} from "../core/types.ts";

export type InvoiceCall =
  | { transport: "ok"; body: FbrInvoiceResponse }
  /** The request never reached processing, so nothing was filed. Safe to report as a failure. */
  | { transport: "not-filed"; reason: string }
  /** We cannot tell whether FBR recorded the invoice. Must surface as "uncertain", never a retry. */
  | { transport: "ambiguous"; reason: string };

export type ReferenceCall<T> = { ok: true; data: T } | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 30_000;

export interface FbrClientOptions {
  mock?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class FbrClient {
  private readonly mock: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FbrClientOptions = {}) {
    this.mock = options.mock ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get isMock(): boolean {
    return this.mock;
  }

  // -------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------

  async validateInvoice(token: string, env: Env, payload: FbrInvoicePayload): Promise<InvoiceCall> {
    if (this.mock) return mockInvoiceCall(payload, "validate");
    return this.invoiceCall(invoiceUrl("validate", env), token, payload);
  }

  async postInvoice(token: string, env: Env, payload: FbrInvoicePayload): Promise<InvoiceCall> {
    if (this.mock) return mockInvoiceCall(payload, "post");
    return this.invoiceCall(invoiceUrl("post", env), token, payload);
  }

  private async invoiceCall(url: string, token: string, payload: FbrInvoicePayload): Promise<InvoiceCall> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The request left this process and we never heard back. FBR may have recorded it.
      return {
        transport: "ambiguous",
        reason: `Couldn't reach FBR (${describeError(error)}). The invoice may or may not have been filed.`,
      };
    }

    // 401 is decided at the gateway before the invoice is processed, so nothing was filed.
    if (response.status === 401) {
      return {
        transport: "not-filed",
        reason:
          "FBR rejected the token (401 Unauthorized). Check the token for this account and environment in Settings, and that this machine's IP is whitelisted in IRIS.",
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return {
        transport: "ambiguous",
        reason: `FBR's reply was cut off (${describeError(error)}).`,
      };
    }

    if (!response.ok) {
      return {
        transport: "ambiguous",
        reason: `FBR returned HTTP ${response.status}. ${truncate(text)}`,
      };
    }

    try {
      return { transport: "ok", body: JSON.parse(text) as FbrInvoiceResponse };
    } catch {
      return {
        transport: "ambiguous",
        reason: `FBR's reply wasn't valid JSON. ${truncate(text)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------------

  async getProvinces(token: string): Promise<ReferenceCall<Province[]>> {
    if (this.mock) return { ok: true, data: MOCK_PROVINCES };
    return this.getJson<Province[]>(REFERENCE_ENDPOINTS.provinces, token);
  }

  async getHsCodes(token: string): Promise<ReferenceCall<HsCode[]>> {
    if (this.mock) return { ok: true, data: MOCK_HS_CODES };
    return this.getJson<HsCode[]>(REFERENCE_ENDPOINTS.hsCodes, token);
  }

  async getTransactionTypes(token: string): Promise<ReferenceCall<TransactionType[]>> {
    if (this.mock) return { ok: true, data: MOCK_TRANSACTION_TYPES };
    return this.getJson<TransactionType[]>(REFERENCE_ENDPOINTS.transactionTypes, token);
  }

  async getUnitsOfMeasure(token: string): Promise<ReferenceCall<UnitOfMeasure[]>> {
    if (this.mock) return { ok: true, data: MOCK_UOMS };
    return this.getJson<UnitOfMeasure[]>(REFERENCE_ENDPOINTS.unitsOfMeasure, token);
  }

  /**
   * Rates are date-keyed because they change by SRO, and the date format here is DD-MMM-YYYY —
   * not the YYYY-MM-DD the invoice payload uses. A wrong format returns an empty list, not an error.
   */
  async getSaleTypeRates(
    token: string,
    params: { date: Date; transTypeId: number; originationSupplier: number },
  ): Promise<ReferenceCall<SaleTypeRate[]>> {
    if (this.mock) return { ok: true, data: MOCK_RATES };
    const url = new URL(REFERENCE_ENDPOINTS.saleTypeToRate);
    url.searchParams.set("date", referenceDateFormat(params.date));
    url.searchParams.set("transTypeId", String(params.transTypeId));
    url.searchParams.set("originationSupplier", String(params.originationSupplier));
    return this.getJson<SaleTypeRate[]>(url.toString(), token);
  }

  /** The units of measure FBR allows for a given HS code (error 0099 when they don't match). */
  async getUomForHsCode(
    token: string,
    hsCode: string,
    annexureId = 3,
  ): Promise<ReferenceCall<UnitOfMeasure[]>> {
    if (this.mock) return { ok: true, data: MOCK_UOMS };
    const url = new URL(REFERENCE_ENDPOINTS.hsCodeUom);
    url.searchParams.set("hs_code", hsCode);
    url.searchParams.set("annexure_id", String(annexureId));
    return this.getJson<UnitOfMeasure[]>(url.toString(), token);
  }

  /**
   * Resolves whether a buyer is registered, so the form can stop guessing (errors 0012 and 0053).
   *
   * The spec labels this GET but shows a JSON request body, which cannot both be true. POST is the
   * reading that matches the body; flagged in docs/ROADMAP.md to confirm against sandbox.
   */
  async getBuyerRegistrationType(
    token: string,
    registrationNo: string,
  ): Promise<ReferenceCall<RegistrationTypeResponse>> {
    if (this.mock) {
      return {
        ok: true,
        data: {
          statuscode: registrationNo.trim().length === 7 ? "00" : "01",
          REGISTRATION_NO: registrationNo,
          REGISTRATION_TYPE: registrationNo.trim().length === 7 ? "Registered" : "unregistered",
        },
      };
    }

    return this.sendJson<RegistrationTypeResponse>(BUYER_ENDPOINTS.registrationType, token, {
      Registration_No: registrationNo.trim(),
    });
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private async getJson<T>(url: string, token: string): Promise<ReferenceCall<T>> {
    return this.request<T>(url, token, undefined);
  }

  private async sendJson<T>(url: string, token: string, body: unknown): Promise<ReferenceCall<T>> {
    return this.request<T>(url, token, body);
  }

  private async request<T>(url: string, token: string, body: unknown): Promise<ReferenceCall<T>> {
    try {
      const response = await this.fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 401) {
        return { ok: false, reason: "FBR rejected the token (401 Unauthorized)." };
      }
      if (!response.ok) {
        return { ok: false, reason: `FBR returned HTTP ${response.status}.` };
      }

      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      return { ok: false, reason: `Couldn't reach FBR (${describeError(error)}).` };
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timed out" : error.message;
  }
  return String(error);
}

function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

// ---------------------------------------------------------------------------
// Mock mode
// ---------------------------------------------------------------------------

/**
 * Canned responses for offline development.
 *
 * Driven by the product description so a developer can exercise every branch without touching FBR:
 *
 *   - "REJECT"          item-level rejection, in FBR's real shape (outer statusCode "00")
 *   - "HEADERFAIL"      header-level rejection
 *   - "TIMEOUT"         pre-check passes, then the FILING goes ambiguous
 *   - "PRECHECKTIMEOUT" the pre-check itself goes ambiguous
 *
 * The two timeout triggers are deliberately separate, because the stage changes the meaning
 * entirely. An ambiguous pre-check files nothing and is safe to retry; an ambiguous filing is the
 * dangerous case that leaves an invoice in an unknown state, and it is the one worth rehearsing.
 */
function mockInvoiceCall(payload: FbrInvoicePayload, action: "post" | "validate"): InvoiceCall {
  const trigger = payload.items.map((i) => i.productDescription).join(" ").toUpperCase();

  if (trigger.includes("PRECHECKTIMEOUT") && action === "validate") {
    return {
      transport: "ambiguous",
      reason: "Mock mode: simulated timeout during the pre-check. Nothing was filed.",
    };
  }

  if (trigger.includes("TIMEOUT") && action === "post") {
    return {
      transport: "ambiguous",
      reason: "Mock mode: simulated timeout while filing. The invoice may or may not have been filed.",
    };
  }

  if (trigger.includes("HEADERFAIL")) {
    return {
      transport: "ok",
      body: {
        dated: mockTimestamp(),
        validationResponse: {
          statusCode: "01",
          status: "Invalid",
          errorCode: "0052",
          error: "Provide proper HS Code with invoice no. null",
          invoiceStatuses: null,
        },
      },
    };
  }

  if (trigger.includes("REJECT")) {
    return {
      transport: "ok",
      body: {
        dated: mockTimestamp(),
        validationResponse: {
          // Note the "00" here: this is FBR's real shape for an item-level rejection.
          statusCode: "00",
          status: "invalid",
          error: "",
          invoiceStatuses: payload.items.map((_, index) => ({
            itemSNo: String(index + 1),
            statusCode: index === 0 ? "01" : "00",
            status: index === 0 ? "Invalid" : "Valid",
            invoiceNo: null,
            errorCode: index === 0 ? "0046" : "",
            error: index === 0 ? "Provide rate." : "",
          })),
        },
      },
    };
  }

  const irn = `${payload.sellerNTNCNIC}DI${mockEpochMs()}`;
  const statuses = payload.items.map((_, index) => ({
    itemSNo: String(index + 1),
    statusCode: "00",
    status: "Valid",
    errorCode: "",
    error: "",
    ...(action === "post" ? { invoiceNo: `${irn}-${index + 1}` } : {}),
  }));

  return {
    transport: "ok",
    body: {
      // validateinvoicedata never returns an invoice number.
      ...(action === "post" ? { invoiceNumber: irn } : {}),
      dated: mockTimestamp(),
      validationResponse: {
        statusCode: "00",
        status: "Valid",
        error: "",
        invoiceStatuses: statuses,
      },
    },
  };
}

function mockTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let lastMockEpochMs = 0;

/**
 * A strictly increasing millisecond value for mock IRNs.
 *
 * `Date.now()` alone hands two invoices submitted in the same millisecond an identical invoice
 * number, which real FBR would never do and which makes mock data misleading to test against.
 */
function mockEpochMs(): number {
  lastMockEpochMs = Math.max(Date.now(), lastMockEpochMs + 1);
  return lastMockEpochMs;
}

const MOCK_PROVINCES: Province[] = [
  { stateProvinceCode: 2, stateProvinceDesc: "BALOCHISTAN" },
  { stateProvinceCode: 4, stateProvinceDesc: "AZAD JAMMU AND KASHMIR" },
  { stateProvinceCode: 5, stateProvinceDesc: "CAPITAL TERRITORY" },
  { stateProvinceCode: 6, stateProvinceDesc: "KHYBER PAKHTUNKHWA" },
  { stateProvinceCode: 7, stateProvinceDesc: "PUNJAB" },
  { stateProvinceCode: 8, stateProvinceDesc: "SINDH" },
  { stateProvinceCode: 9, stateProvinceDesc: "GILGIT BALTISTAN" },
];

const MOCK_HS_CODES: HsCode[] = [
  { hS_CODE: "0101.2100", description: "Pure-bred breeding horses" },
  { hS_CODE: "1006.3010", description: "Basmati rice, semi-milled or wholly milled" },
  { hS_CODE: "2523.2910", description: "Portland cement (other)" },
  { hS_CODE: "5208.1100", description: "Plain weave cotton fabric, unbleached" },
  { hS_CODE: "8432.1010", description: "Ploughs for agricultural use" },
  { hS_CODE: "8517.1210", description: "Cellular mobile phones" },
  { hS_CODE: "9999.0000", description: "Services (general)" },
];

const MOCK_TRANSACTION_TYPES: TransactionType[] = [
  { transactioN_TYPE_ID: 18, transactioN_DESC: "Goods at standard rate (default)" },
  { transactioN_TYPE_ID: 19, transactioN_DESC: "Goods at Reduced Rate" },
  { transactioN_TYPE_ID: 20, transactioN_DESC: "Goods at zero-rate" },
  { transactioN_TYPE_ID: 21, transactioN_DESC: "Exempt Goods" },
  { transactioN_TYPE_ID: 24, transactioN_DESC: "3rd Schedule Goods" },
  { transactioN_TYPE_ID: 30, transactioN_DESC: "Services" },
  { transactioN_TYPE_ID: 33, transactioN_DESC: "Mobile Phones" },
];

const MOCK_UOMS: UnitOfMeasure[] = [
  { uoM_ID: 1, description: "Numbers, pieces, units" },
  { uoM_ID: 2, description: "KG" },
  { uoM_ID: 3, description: "Square Metre" },
  { uoM_ID: 4, description: "Litre" },
  { uoM_ID: 5, description: "KWH" },
  { uoM_ID: 6, description: "Bill of lading" },
];

const MOCK_RATES: SaleTypeRate[] = [
  { ratE_ID: 413, ratE_DESC: "18%", ratE_VALUE: 18 },
  { ratE_ID: 414, ratE_DESC: "0%", ratE_VALUE: 0 },
  { ratE_ID: 415, ratE_DESC: "5%", ratE_VALUE: 5 },
  { ratE_ID: 416, ratE_DESC: "10%", ratE_VALUE: 10 },
  // A real compound rate, kept in the mock set so the low-confidence path is exercised in dev.
  { ratE_ID: 417, ratE_DESC: "18% along with rupees 60 per kilogram", ratE_VALUE: 18 },
];
