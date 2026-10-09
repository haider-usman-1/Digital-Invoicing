import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheKey,
  clearCache,
  deleteAccount,
  loadAccounts,
  readCache,
  redactAccount,
  tokenFor,
  upsertAccount,
  writeCache,
} from "../src/server/store.ts";
import type { Account } from "../src/core/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fbr-di-store-"));
  process.env.FBR_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.FBR_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const ACCOUNT: Omit<Account, "id"> = {
  label: "Acme Traders",
  sellerNTNCNIC: "0786909",
  sellerBusinessName: "Acme Traders (Pvt) Ltd",
  sellerProvince: "Sindh",
  sellerAddress: "Karachi",
  sandboxToken: "sandbox-abc",
  productionToken: "production-xyz",
  eligibleScenarios: ["SN001", "SN002"],
};

describe("accounts", () => {
  test("starts empty and round-trips an account", () => {
    expect(loadAccounts()).toEqual([]);
    const saved = upsertAccount(ACCOUNT);
    expect(saved.id).toBeTruthy();
    expect(loadAccounts()).toHaveLength(1);
    expect(loadAccounts()[0]!.sellerNTNCNIC).toBe("0786909");
  });

  test("updates in place rather than duplicating", () => {
    const saved = upsertAccount(ACCOUNT);
    upsertAccount({ ...ACCOUNT, id: saved.id, label: "Acme Renamed" });

    const accounts = loadAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.label).toBe("Acme Renamed");
  });

  test("deletes by id", () => {
    const saved = upsertAccount(ACCOUNT);
    deleteAccount(saved.id);
    expect(loadAccounts()).toEqual([]);
  });
});

describe("tokenFor", () => {
  test("picks the token matching the environment", () => {
    const account: Account = { ...ACCOUNT, id: "a" };
    const sandbox = tokenFor(account, "sandbox");
    const production = tokenFor(account, "production");

    expect(sandbox).toEqual({ ok: true, token: "sandbox-abc" });
    expect(production).toEqual({ ok: true, token: "production-xyz" });
  });

  test("explains a missing production token as a normal state, not an error", () => {
    // An account still working through sandbox scenario validation has no production token yet.
    // The message should say why rather than leaving the user guessing.
    const account: Account = { ...ACCOUNT, id: "a", productionToken: "" };
    const result = tokenFor(account, "production");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/scenario/i);
    expect(result.reason).toContain("Acme Traders");
  });

  test("points at IRIS when the sandbox token is missing", () => {
    const account: Account = { ...ACCOUNT, id: "a", sandboxToken: "   " };
    const result = tokenFor(account, "sandbox");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/IRIS/);
  });
});

describe("redactAccount", () => {
  test("strips both tokens while reporting whether they're set", () => {
    const redacted = redactAccount({ ...ACCOUNT, id: "a", productionToken: "" });

    expect(JSON.stringify(redacted)).not.toContain("sandbox-abc");
    expect(redacted.hasSandboxToken).toBe(true);
    expect(redacted.hasProductionToken).toBe(false);
    expect(redacted.sellerNTNCNIC).toBe("0786909");
  });
});

describe("reference cache", () => {
  test("keys on every parameter, so a date change can't serve a stale rate", () => {
    // SaleTypeToRate is date-keyed because rates change by SRO. Caching without the date would
    // produce error 0104, which looks exactly like a calculation bug.
    const monday = cacheKey("SaleTypeToRate", { date: "09-Oct-2026", transTypeId: 18, originationSupplier: 1 });
    const tuesday = cacheKey("SaleTypeToRate", { date: "10-Oct-2026", transTypeId: 18, originationSupplier: 1 });
    expect(monday).not.toBe(tuesday);
  });

  test("builds the same key regardless of parameter order", () => {
    expect(cacheKey("x", { b: 2, a: 1 })).toBe(cacheKey("x", { a: 1, b: 2 }));
  });

  test("round-trips a value and respects the max age", () => {
    writeCache("provinces", [{ stateProvinceCode: 8, stateProvinceDesc: "SINDH" }]);
    expect(readCache("provinces", 60_000)).toHaveLength(1);
    // Nothing is fresh when the allowed age is zero.
    expect(readCache("provinces", 0)).toBeUndefined();
  });

  test("returns undefined for an unknown key and after clearing", () => {
    expect(readCache("never-fetched", 60_000)).toBeUndefined();
    writeCache("uom", [1]);
    clearCache();
    expect(readCache("uom", 60_000)).toBeUndefined();
  });
});
