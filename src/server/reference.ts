/**
 * Cached access to FBR's reference lists.
 *
 * These lists are what make the form reliable: `rate`, `uoM` and `saleType` all travel to FBR as
 * description STRINGS that must match its own reference data exactly, so anything typed by hand is
 * a guess. Caching is aggressive because the data is near-static and FBR publishes no rate limits.
 *
 * The one genuinely dynamic list is SaleTypeToRate, which takes a date because rates change by
 * SRO — so its cache key includes the date. Caching it without the date would serve a stale rate
 * and produce error 0104, a failure that looks exactly like a calculation bug.
 */

import { FbrClient } from "./fbr-client.ts";
import type { ReferenceCall } from "./fbr-client.ts";
import { cacheKey, readCache, writeCache } from "./store.ts";
import { referenceDateFormat } from "../core/endpoints.ts";
import type { HsCode, Province, SaleTypeRate, TransactionType, UnitOfMeasure } from "../core/types.ts";

/** Near-static lists: provinces, HS codes, transaction types, units of measure. */
const STATIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Rates are already keyed by date, so this only guards against same-day churn. */
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<ReferenceCall<T>>,
): Promise<ReferenceCall<T>> {
  const hit = readCache<T>(key, ttlMs);
  if (hit !== undefined) return { ok: true, data: hit };

  const result = await fetcher();
  // An empty list is not worth remembering for a week: it usually means the question was wrong
  // (a partial HS code, say) rather than that FBR genuinely has nothing to say.
  const worthCaching = result.ok && (!Array.isArray(result.data) || result.data.length > 0);
  if (worthCaching) writeCache(key, result.data);
  return result;
}

export interface FormReferenceData {
  provinces: Province[];
  hsCodes: HsCode[];
  transactionTypes: TransactionType[];
  unitsOfMeasure: UnitOfMeasure[];
}

/** Everything the invoice form needs to populate its pickers, in one round of calls. */
export async function loadFormReference(
  client: FbrClient,
  token: string,
): Promise<{ ok: true; data: FormReferenceData } | { ok: false; reason: string }> {
  const [provinces, hsCodes, transactionTypes, unitsOfMeasure] = await Promise.all([
    cached(cacheKey("provinces"), STATIC_TTL_MS, () => client.getProvinces(token)),
    cached(cacheKey("itemdesccode"), STATIC_TTL_MS, () => client.getHsCodes(token)),
    cached(cacheKey("transtypecode"), STATIC_TTL_MS, () => client.getTransactionTypes(token)),
    cached(cacheKey("uom"), STATIC_TTL_MS, () => client.getUnitsOfMeasure(token)),
  ]);

  const failure = [provinces, hsCodes, transactionTypes, unitsOfMeasure].find((r) => !r.ok);
  if (failure && !failure.ok) return { ok: false, reason: failure.reason };

  return {
    ok: true,
    data: {
      provinces: (provinces as { ok: true; data: Province[] }).data,
      hsCodes: (hsCodes as { ok: true; data: HsCode[] }).data,
      transactionTypes: (transactionTypes as { ok: true; data: TransactionType[] }).data,
      unitsOfMeasure: (unitsOfMeasure as { ok: true; data: UnitOfMeasure[] }).data,
    },
  };
}

export async function loadRates(
  client: FbrClient,
  token: string,
  params: { date: Date; transTypeId: number; originationSupplier: number },
): Promise<ReferenceCall<SaleTypeRate[]>> {
  const key = cacheKey("SaleTypeToRate", {
    date: referenceDateFormat(params.date),
    transTypeId: params.transTypeId,
    originationSupplier: params.originationSupplier,
  });
  return cached(key, RATE_TTL_MS, () => client.getSaleTypeRates(token, params));
}

/** The units of measure FBR permits for a given HS code — error 0099 when they don't match. */
export async function loadUomForHsCode(
  client: FbrClient,
  token: string,
  hsCode: string,
): Promise<ReferenceCall<UnitOfMeasure[]>> {
  const key = cacheKey("HS_UOM", { hs_code: hsCode, annexure_id: 3 });
  return cached(key, STATIC_TTL_MS, () => client.getUomForHsCode(token, hsCode));
}
