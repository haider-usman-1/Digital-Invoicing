/**
 * Account configuration and reference-data cache.
 *
 * The account is the atomic owner of its seller block and both of its tokens. FBR binds every token
 * to the NTN it was issued to and rejects a mismatch with error 0401, and with several accounts
 * times two environments the likeliest real-world mistake is pairing one account's token with
 * another's seller details. `tokenFor` is the only place a token is selected, so there is exactly
 * one path to get that pairing wrong, and it is right here and tested.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ACCOUNTS_FILE, REFERENCE_CACHE_FILE, dataFile } from "./paths.ts";
import type { Account, Env } from "../core/types.ts";

export interface AccountsFile {
  version: 1;
  accounts: Account[];
}

const emptyAccountsFile = (): AccountsFile => ({ version: 1, accounts: [] });

/**
 * Reads JSON, falling back to a freshly built default.
 *
 * The fallback is a factory rather than a value on purpose: returning a shared constant hands
 * callers a reference they then mutate, so the "empty" default accumulates state for the life of
 * the process and every later read sees it.
 */
function readJson<T>(path: string, makeFallback: () => T): T {
  if (!existsSync(path)) return makeFallback();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A corrupt config must not take the app down — the user can re-enter it in Settings.
    return makeFallback();
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function loadAccounts(): Account[] {
  return readJson<AccountsFile>(dataFile(ACCOUNTS_FILE), emptyAccountsFile).accounts;
}

export function saveAccounts(accounts: Account[]): void {
  writeJson(dataFile(ACCOUNTS_FILE), { version: 1, accounts } satisfies AccountsFile);
}

export function findAccount(accounts: Account[], id: string): Account | undefined {
  return accounts.find((a) => a.id === id);
}

export function upsertAccount(input: Omit<Account, "id"> & { id?: string }): Account {
  const accounts = loadAccounts();
  const account: Account = { ...input, id: input.id ?? randomUUID() };
  const index = accounts.findIndex((a) => a.id === account.id);
  if (index >= 0) accounts[index] = account;
  else accounts.push(account);
  saveAccounts(accounts);
  return account;
}

export function deleteAccount(id: string): void {
  saveAccounts(loadAccounts().filter((a) => a.id !== id));
}

/**
 * The single place a token is chosen.
 *
 * Returns an explanation rather than an empty string when the token is missing, because "no
 * production token yet" is the normal state for an account still working through sandbox
 * scenario validation — not an error to be puzzled over.
 */
export function tokenFor(account: Account, env: Env): { ok: true; token: string } | { ok: false; reason: string } {
  const token = (env === "sandbox" ? account.sandboxToken : account.productionToken).trim();

  if (token === "") {
    return {
      ok: false,
      reason:
        env === "sandbox"
          ? `No sandbox token saved for "${account.label}". Copy it from IRIS: Digital Invoicing > Sandbox Environment > View Web API Environment Details.`
          : `No production token saved for "${account.label}". FBR issues it automatically once this account has posted a valid invoice for every one of its eligible scenarios in sandbox.`,
    };
  }

  return { ok: true, token };
}

/** Redacts tokens before an account is sent to the browser or written to a log. */
export function redactAccount(account: Account): Omit<Account, "sandboxToken" | "productionToken"> & {
  hasSandboxToken: boolean;
  hasProductionToken: boolean;
} {
  const { sandboxToken, productionToken, ...rest } = account;
  return {
    ...rest,
    hasSandboxToken: sandboxToken.trim() !== "",
    hasProductionToken: productionToken.trim() !== "",
  };
}

// ---------------------------------------------------------------------------
// Reference cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: string;
  data: unknown;
}

interface ReferenceCacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const emptyCacheFile = (): ReferenceCacheFile => ({ version: 1, entries: {} });

/**
 * Cache keys must include every query parameter that changes the answer.
 *
 * SaleTypeToRate in particular is date-keyed because rates change by SRO, so caching "the rate
 * list" without the date would serve a stale rate and produce error 0104 — a failure that looks
 * exactly like a calculation bug.
 */
export function cacheKey(name: string, params: Record<string, string | number> = {}): string {
  const suffix = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return suffix ? `${name}?${suffix}` : name;
}

export function readCache<T>(key: string, maxAgeMs: number): T | undefined {
  // A non-positive max age means "force a refresh". Treating it as a duration instead would make
  // the answer depend on whether the read happened in the same millisecond as the write.
  if (maxAgeMs <= 0) return undefined;

  const cache = readJson<ReferenceCacheFile>(dataFile(REFERENCE_CACHE_FILE), emptyCacheFile);
  const entry = cache.entries[key];
  if (!entry) return undefined;

  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (!Number.isFinite(age) || age > maxAgeMs) return undefined;

  return entry.data as T;
}

export function writeCache(key: string, data: unknown): void {
  const path = dataFile(REFERENCE_CACHE_FILE);
  const cache = readJson<ReferenceCacheFile>(path, emptyCacheFile);
  cache.entries[key] = { fetchedAt: new Date().toISOString(), data };
  writeJson(path, cache);
}

export function clearCache(): void {
  writeJson(dataFile(REFERENCE_CACHE_FILE), emptyCacheFile());
}
