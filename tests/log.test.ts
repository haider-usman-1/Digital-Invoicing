import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completedScenarios,
  foldSubmissions,
  needsAttention,
  portalSearchHints,
  recordAttempt,
  recordResolution,
  recordResult,
} from "../src/server/log.ts";
import type { AttemptDetails } from "../src/server/log.ts";
import type { Env, FbrInvoicePayload } from "../src/core/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fbr-di-test-"));
  process.env.FBR_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.FBR_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function payload(overrides: Partial<FbrInvoicePayload> = {}): FbrInvoicePayload {
  return {
    invoiceType: "Sale Invoice",
    invoiceDate: "2026-10-09",
    sellerNTNCNIC: "0786909",
    sellerBusinessName: "Acme Traders",
    sellerProvince: "Sindh",
    sellerAddress: "Karachi",
    buyerNTNCNIC: "1000000000000",
    buyerBusinessName: "Buyer Ltd",
    buyerProvince: "Punjab",
    buyerAddress: "Lahore",
    buyerRegistrationType: "Unregistered",
    invoiceRefNo: "",
    items: [
      {
        hsCode: "0101.2100",
        productDescription: "thing",
        rate: "18%",
        uoM: "KG",
        quantity: 10,
        totalValues: 0,
        valueSalesExcludingST: 1000,
        fixedNotifiedValueOrRetailPrice: 0,
        salesTaxApplicable: 180,
        salesTaxWithheldAtSource: 0,
        extraTax: 0,
        furtherTax: 0,
        sroScheduleNo: "",
        fedPayable: 0,
        discount: 0,
        saleType: "Goods at standard rate (default)",
        sroItemSerialNo: "",
      },
    ],
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptDetails> = {}): AttemptDetails {
  return {
    accountId: "acct-1",
    accountLabel: "Acme Traders",
    env: "sandbox" as Env,
    internalInvoiceNumber: "ACME-2026-0001",
    payload: payload(),
    ...overrides,
  };
}

describe("submission log", () => {
  test("an attempt with no result folds to pending and needs attention", () => {
    // This is the crash case: the attempt was written, the process died, and we genuinely do not
    // know whether FBR filed the invoice.
    recordAttempt(attempt());

    const submissions = foldSubmissions();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.status).toBe("pending");
    expect(needsAttention(submissions)).toHaveLength(1);
  });

  test("records a success with its IRN", () => {
    const id = recordAttempt(attempt());
    recordResult(id, { kind: "success", irn: "0786909DI1747119701593", dated: "2026-10-09 12:01:41" });

    const [submission] = foldSubmissions();
    expect(submission!.status).toBe("success");
    expect(submission!.irn).toBe("0786909DI1747119701593");
    expect(needsAttention()).toHaveLength(0);
  });

  test("records a rejection with its errors and does not flag it for attention", () => {
    // A clean rejection is not ambiguous: nothing was filed, so there is nothing to reconcile.
    const id = recordAttempt(attempt());
    recordResult(id, {
      kind: "rejected",
      errors: [{ code: "0046", fbrMessage: "Provide rate.", plain: "The tax rate is missing.", field: "rate", itemSNo: "1" }],
    });

    const [submission] = foldSubmissions();
    expect(submission!.status).toBe("rejected");
    expect(submission!.errors[0]!.code).toBe("0046");
    expect(needsAttention()).toHaveLength(0);
  });

  test("keeps an uncertain submission flagged until it is resolved", () => {
    const id = recordAttempt(attempt());
    recordResult(id, { kind: "uncertain", reason: "Couldn't reach FBR (timed out)." });
    expect(needsAttention()).toHaveLength(1);

    recordResolution(id, "0786909DI1747119701593", "Found in IRIS portal, invoice was filed.");

    const [submission] = foldSubmissions();
    expect(submission!.status).toBe("resolved");
    expect(submission!.irn).toBe("0786909DI1747119701593");
    expect(submission!.resolutionNote).toContain("Found in IRIS");
    expect(needsAttention()).toHaveLength(0);
  });

  test("stores the full payload, so an uncertain invoice can be searched for in IRIS", () => {
    const id = recordAttempt(attempt());
    recordResult(id, { kind: "uncertain", reason: "timed out" });

    const hints = portalSearchHints(foldSubmissions()[0]!);
    expect(hints.invoiceDate).toBe("2026-10-09");
    expect(hints.buyerName).toBe("Buyer Ltd");
    expect(hints.totalExcludingTax).toBe(1000);
    expect(hints.sellerNTNCNIC).toBe("0786909");
  });

  test("never writes a token to disk", () => {
    const id = recordAttempt(attempt());
    recordResult(id, { kind: "success", irn: "x", dated: null });

    const contents = readFileSync(join(dir, "submissions.ndjson"), "utf8");
    expect(contents.toLowerCase()).not.toContain("token");
    expect(contents.toLowerCase()).not.toContain("authorization");
  });

  test("survives a torn final line from an unclean shutdown", () => {
    const id = recordAttempt(attempt());
    recordResult(id, { kind: "success", irn: "0786909DI1", dated: null });
    Bun.spawnSync(["sh", "-c", `printf '{"type":"SUBMIT_ATT' >> ${JSON.stringify(join(dir, "submissions.ndjson"))}`]);

    const submissions = foldSubmissions();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.status).toBe("success");
  });

  test("orders newest first", async () => {
    const first = recordAttempt(attempt({ internalInvoiceNumber: "OLD" }));
    recordResult(first, { kind: "success", irn: "a", dated: null });
    await Bun.sleep(5);
    const second = recordAttempt(attempt({ internalInvoiceNumber: "NEW" }));
    recordResult(second, { kind: "success", irn: "b", dated: null });

    expect(foldSubmissions().map((s) => s.internalInvoiceNumber)).toEqual(["NEW", "OLD"]);
  });
});

describe("completedScenarios", () => {
  function submitScenario(scenarioId: string, env: Env, kind: "success" | "rejected") {
    const id = recordAttempt(attempt({ env, payload: payload({ scenarioId }) }));
    recordResult(
      id,
      kind === "success"
        ? { kind: "success", irn: `irn-${scenarioId}`, dated: null }
        : { kind: "rejected", errors: [] },
    );
  }

  test("counts a scenario only once it has been posted successfully", () => {
    submitScenario("SN001", "sandbox", "success");
    submitScenario("SN002", "sandbox", "rejected");

    const done = completedScenarios("acct-1");
    expect(done.has("SN001")).toBe(true);
    expect(done.has("SN002")).toBe(false);
  });

  test("ignores other accounts", () => {
    const id = recordAttempt(attempt({ accountId: "acct-2", payload: payload({ scenarioId: "SN005" }) }));
    recordResult(id, { kind: "success", irn: "x", dated: null });

    expect(completedScenarios("acct-1").size).toBe(0);
    expect(completedScenarios("acct-2").has("SN005")).toBe(true);
  });

  test("ignores production submissions, which don't carry a scenario at all", () => {
    submitScenario("SN001", "production", "success");
    expect(completedScenarios("acct-1").size).toBe(0);
  });
});
