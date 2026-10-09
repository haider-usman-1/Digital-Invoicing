import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * End-to-end test against a real server process in mock mode.
 *
 * This covers the wiring the unit tests can't: the security guards, the full submit flow through
 * pre-check and filing, and the way an uncertain submission is recorded and later closed out.
 * Mock mode means no token and no network, so this runs anywhere.
 */

const PORT = 7399;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Subprocess;
let dir: string;
let secret: string;
let accountId: string;

async function waitForServer(timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/session`);
      if (response.ok) return ((await response.json()) as { secret: string }).secret;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(150);
  }
  throw new Error("Server did not start in time");
}

function authed(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-fbr-session": secret,
      ...init.headers,
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fbr-di-e2e-"));
  server = Bun.spawn(["bun", "src/server/index.ts"], {
    env: { ...process.env, FBR_DATA_DIR: dir, FBR_MOCK: "1", FBR_DEV: "1", PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  secret = await waitForServer();

  const created = await json<{ account: { id: string } }>(
    await authed("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        label: "Acme Traders",
        sellerNTNCNIC: "0786909",
        sellerBusinessName: "Acme Traders (Pvt) Ltd",
        sellerProvince: "Sindh",
        sellerAddress: "Karachi",
        sandboxToken: "sandbox-token",
        eligibleScenarios: ["SN001", "SN002"],
      }),
    }),
  );
  accountId = created.account.id;
});

afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

function invoice(description: string, scenarioId = "SN001") {
  return {
    accountId,
    env: "sandbox",
    scenarioId,
    invoiceDate: "2026-10-09",
    internalInvoiceNumber: "ACME-2026-0001",
    buyer: {
      ntncnic: "1000000000000",
      businessName: "Buyer Ltd",
      province: "Punjab",
      address: "Lahore",
      registrationType: "Unregistered",
    },
    items: [
      {
        hsCode: "0101.2100",
        productDescription: description,
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
  };
}

describe("security guards", () => {
  test("refuses an API call with no session key", async () => {
    const response = await fetch(`${BASE}/api/accounts`);
    expect(response.status).toBe(403);
  });

  test("refuses a valid key sent from a foreign origin", async () => {
    const response = await authed("/api/accounts", { headers: { Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  test("refuses a request whose Host header isn't loopback, which is what DNS rebinding looks like", async () => {
    const response = await authed("/api/accounts", { headers: { Host: "evil.example" } });
    expect(response.status).toBe(403);
  });

  test("never sends a CORS header that would let another site read a response", async () => {
    const response = await fetch(`${BASE}/api/session`);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("accounts", () => {
  test("stores the account but never returns its tokens to the browser", async () => {
    const { accounts } = await json<{ accounts: Array<Record<string, unknown>> }>(
      await authed("/api/accounts"),
    );

    expect(accounts).toHaveLength(1);
    expect(JSON.stringify(accounts)).not.toContain("sandbox-token");
    expect(accounts[0]!.hasSandboxToken).toBe(true);
    expect(accounts[0]!.hasProductionToken).toBe(false);
  });

  test("refuses to save an account with no seller NTN", async () => {
    const response = await authed("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ label: "Nameless" }),
    });
    expect(response.status).toBe(400);
  });

  test("blocks production submission while no production token exists, and explains why", async () => {
    const result = await json<{ error?: string; message?: string }>(
      await authed("/api/invoice/submit", {
        method: "POST",
        body: JSON.stringify({ ...invoice("widget"), env: "production", scenarioId: undefined }),
      }),
    );
    expect(`${result.error ?? ""}${result.message ?? ""}`).toMatch(/production token/i);
  });
});

describe("reference data", () => {
  test("serves the lists the form needs", async () => {
    const data = await json<Record<string, unknown[]>>(
      await authed(`/api/reference?accountId=${accountId}&env=sandbox`),
    );
    expect(data.provinces!.length).toBeGreaterThan(0);
    expect(data.hsCodes!.length).toBeGreaterThan(0);
    expect(data.transactionTypes!.length).toBeGreaterThan(0);
    expect(data.unitsOfMeasure!.length).toBeGreaterThan(0);
  });

  test("resolves a buyer's registration type", async () => {
    const { registrationType } = await json<{ registrationType: string }>(
      await authed("/api/buyer-lookup", {
        method: "POST",
        body: JSON.stringify({ accountId, env: "sandbox", registrationNo: "0786909" }),
      }),
    );
    expect(registrationType).toBe("Registered");
  });
});

describe("submitting an invoice", () => {
  test("files successfully and returns an IRN in FBR's format", async () => {
    const result = await json<{ status: string; irn: string }>(
      await authed("/api/invoice/submit", { method: "POST", body: JSON.stringify(invoice("widget")) }),
    );

    expect(result.status).toBe("success");
    // <sellerNTN>DI<13-digit epoch ms> — 22 characters for a 7-digit NTN.
    expect(result.irn).toMatch(/^0786909DI\d{13}$/);
  });

  test("gives two invoices filed back-to-back distinct invoice numbers", async () => {
    // Two submissions can land in the same millisecond, and an IRN is the only proof a particular
    // invoice exists — duplicates would make the log ambiguous.
    const [first, second] = await Promise.all([
      json<{ irn: string }>(
        await authed("/api/invoice/submit", { method: "POST", body: JSON.stringify(invoice("first")) }),
      ),
      json<{ irn: string }>(
        await authed("/api/invoice/submit", { method: "POST", body: JSON.stringify(invoice("second")) }),
      ),
    ]);

    expect(first.irn).not.toBe(second.irn);
  });

  test("reports an item-level rejection as rejected, not as a success", async () => {
    // The mock returns FBR's real shape here: outer statusCode "00" with a failing item.
    const result = await json<{ status: string; stage: string; errors: Array<{ plain: string }> }>(
      await authed("/api/invoice/submit", { method: "POST", body: JSON.stringify(invoice("REJECT me")) }),
    );

    expect(result.status).toBe("rejected");
    expect(result.errors[0]!.plain).toMatch(/rate/i);
  });

  test("requires a scenario in sandbox", async () => {
    const result = await json<{ status: string; message: string }>(
      await authed("/api/invoice/submit", {
        method: "POST",
        body: JSON.stringify({ ...invoice("widget"), scenarioId: "" }),
      }),
    );
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/scenario/i);
  });

  test("treats an ambiguous pre-check as a plain error, since nothing was filed", async () => {
    const result = await json<{ status: string; message: string }>(
      await authed("/api/invoice/submit", {
        method: "POST",
        body: JSON.stringify(invoice("PRECHECKTIMEOUT case")),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/nothing has been filed/i);

    // And it must not leave anything behind to reconcile.
    const { needsAttention } = await json<{ needsAttention: unknown[] }>(await authed("/api/submissions"));
    expect(needsAttention).toHaveLength(0);
  });

  test("records an ambiguous failure as uncertain with portal search details", async () => {
    const result = await json<{
      status: string;
      submissionId: string;
      portalSearch: Record<string, unknown>;
    }>(await authed("/api/invoice/submit", { method: "POST", body: JSON.stringify(invoice("TIMEOUT now")) }));

    expect(result.status).toBe("uncertain");
    expect(result.portalSearch.buyerName).toBe("Buyer Ltd");
    expect(result.portalSearch.totalExcludingTax).toBe(1000);

    const { needsAttention } = await json<{ needsAttention: Array<{ id: string }> }>(
      await authed("/api/submissions"),
    );
    expect(needsAttention.some((s) => s.id === result.submissionId)).toBe(true);
  });

  test("closes out an uncertain submission once the user supplies the IRN from IRIS", async () => {
    const submitted = await json<{ submissionId: string }>(
      await authed("/api/invoice/submit", { method: "POST", body: JSON.stringify(invoice("TIMEOUT again")) }),
    );

    await authed(`/api/submissions/${submitted.submissionId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ irn: "0786909DI1747119701593", note: "Found in IRIS" }),
    });

    const { needsAttention, submissions } = await json<{
      needsAttention: Array<{ id: string }>;
      submissions: Array<{ id: string; status: string; irn: string }>;
    }>(await authed("/api/submissions"));

    expect(needsAttention.some((s) => s.id === submitted.submissionId)).toBe(false);
    const resolved = submissions.find((s) => s.id === submitted.submissionId)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.irn).toBe("0786909DI1747119701593");
  });

  test("refuses to close out a submission without an IRN", async () => {
    const response = await authed("/api/submissions/does-not-matter/resolve", {
      method: "POST",
      body: JSON.stringify({ irn: "  " }),
    });
    expect(response.status).toBe(400);
  });
});

describe("scenario progress", () => {
  test("counts only the scenario that was actually filed", async () => {
    // SN001 succeeded earlier in this file; SN002 has never been attempted.
    const result = await json<{
      eligible: Array<{ id: string; completed: boolean; saleType: string }>;
      completedCount: number;
    }>(await authed(`/api/scenarios?accountId=${accountId}`));

    expect(result.eligible.find((s) => s.id === "SN001")!.completed).toBe(true);
    expect(result.eligible.find((s) => s.id === "SN002")!.completed).toBe(false);
    expect(result.completedCount).toBe(1);
  });

  test("carries the sale type FBR fixes per scenario, so the form can prefill it", async () => {
    const result = await json<{ eligible: Array<{ id: string; saleType: string }> }>(
      await authed(`/api/scenarios?accountId=${accountId}`),
    );
    expect(result.eligible.find((s) => s.id === "SN001")!.saleType).toBe("Goods at Standard Rate (default)");
  });
});

describe("the served page", () => {
  test("serves the app shell with a bundled script and stylesheet", async () => {
    const html = await (await fetch(BASE)).text();
    expect(html).toContain('<div id="root">');
    expect(html).toMatch(/<script[^>]+src="[^"]+\.js"/);
    expect(html).toMatch(/<link[^>]+href="[^"]+\.css"/);
  });

  test("returns 404 for an unknown path", async () => {
    expect((await fetch(`${BASE}/nope`)).status).toBe(404);
  });
});

describe("scenario templates", () => {
  test("ships a prefilled template with every eligible scenario", async () => {
    // Prefilling only the sale type saves nobody anything — the form has to arrive fileable.
    const { eligible } = await json<{
      eligible: Array<{ id: string; template: { buyer: Record<string, string>; item: Record<string, unknown> } }>;
    }>(await authed(`/api/scenarios?accountId=${accountId}`));

    const sn001 = eligible.find((s) => s.id === "SN001")!;
    expect(sn001.template.item.hsCode).toBeTruthy();
    expect(sn001.template.item.uoM).toBeTruthy();
    expect(sn001.template.item.rateDesc).toBeTruthy();
    expect(sn001.template.item.quantity).toBeGreaterThan(0);
    expect(sn001.template.item.valueSalesExcludingST).toBeGreaterThan(0);
    expect(sn001.template.buyer.businessName).toBeTruthy();
  });

  test("gives a registered buyer to scenarios that need one, and unregistered to the rest", async () => {
    const { eligible } = await json<{
      eligible: Array<{ id: string; template: { buyer: { registrationType: string } } }>;
    }>(await authed(`/api/scenarios?accountId=${accountId}`));

    expect(eligible.find((s) => s.id === "SN001")!.template.buyer.registrationType).toBe("Registered");
    expect(eligible.find((s) => s.id === "SN002")!.template.buyer.registrationType).toBe("Unregistered");
  });

  test("marks built-in templates as not customised and warns what to verify", async () => {
    const { eligible } = await json<{
      eligible: Array<{ id: string; template: { customised: boolean; verify?: string } }>;
    }>(await authed(`/api/scenarios?accountId=${accountId}`));

    const sn001 = eligible.find((s) => s.id === "SN001")!;
    expect(sn001.template.customised).toBe(false);
    // The shipped buyer NTN is a documentation example, so this must say so.
    expect(sn001.template.verify).toMatch(/NTN|HS code/i);
  });

  test("saves a corrected template and serves it back to every account", async () => {
    await authed("/api/scenario-templates/SN001", {
      method: "POST",
      body: JSON.stringify({
        buyer: {
          ntncnic: "0788762",
          businessName: "Verified Buyer Ltd",
          province: "Punjab",
          address: "Lahore",
          registrationType: "Registered",
        },
        item: {
          hsCode: "2523.2910",
          productDescription: "Portland cement",
          uoM: "KG",
          rateDesc: "18%",
          quantity: 5000,
          valueSalesExcludingST: 200000,
        },
      }),
    });

    // Read it back through a different account: a correction is global, because FBR's requirements
    // for a scenario don't vary by registration.
    const { accounts } = await json<{ accounts: Array<{ id: string; label: string }> }>(
      await authed("/api/accounts"),
    );
    const other = accounts.find((a) => a.id !== accountId) ?? accounts[0]!;
    await authed("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ id: other.id, label: other.label, sellerNTNCNIC: "7327556", eligibleScenarios: ["SN001"] }),
    });

    const { eligible } = await json<{
      eligible: Array<{ id: string; template: { customised: boolean; item: { hsCode: string } } }>;
    }>(await authed(`/api/scenarios?accountId=${other.id}`));

    const sn001 = eligible.find((s) => s.id === "SN001")!;
    expect(sn001.template.customised).toBe(true);
    expect(sn001.template.item.hsCode).toBe("2523.2910");
  });

  test("resets a template back to its built-in values", async () => {
    await authed("/api/scenario-templates/SN002", {
      method: "POST",
      body: JSON.stringify({
        buyer: { ntncnic: "1", businessName: "x", province: "y", address: "z", registrationType: "Unregistered" },
        item: { hsCode: "9999.9999", productDescription: "x", uoM: "KG", rateDesc: "18%", quantity: 1, valueSalesExcludingST: 1 },
      }),
    });

    const reset = await json<{ template: { customised: boolean; item: { hsCode: string } } }>(
      await authed("/api/scenario-templates/SN002", { method: "DELETE" }),
    );

    expect(reset.template.customised).toBe(false);
    expect(reset.template.item.hsCode).not.toBe("9999.9999");
  });

  test("refuses a template missing its buyer or item", async () => {
    const response = await authed("/api/scenario-templates/SN005", {
      method: "POST",
      body: JSON.stringify({ item: { hsCode: "1006.3010" } }),
    });
    expect(response.status).toBe(400);
  });
});
