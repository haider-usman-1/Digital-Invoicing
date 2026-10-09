import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/ui/App.tsx";

/**
 * Smoke tests for the UI, run against a stubbed API in a happy-dom environment.
 *
 * These exist because the interesting failures here are the ones a type checker can't see: a screen
 * that throws on mount, a banner that reports the wrong environment, or the app landing somewhere
 * useless when nothing is configured yet. Each of those is invisible until someone opens the app.
 *
 * Separate directory and preload so happy-dom's globals never leak into the server-side tests.
 */

const ACCOUNT = {
  id: "acct-1",
  label: "Acme Traders",
  sellerNTNCNIC: "0786909",
  sellerBusinessName: "Acme Traders (Pvt) Ltd",
  sellerProvince: "Sindh",
  sellerAddress: "Karachi",
  eligibleScenarios: ["SN001", "SN002"],
  hasSandboxToken: true,
  hasProductionToken: false,
};

const REFERENCE = {
  provinces: [{ stateProvinceCode: 8, stateProvinceDesc: "SINDH" }],
  hsCodes: [{ hS_CODE: "0101.2100", description: "Pure-bred breeding horses" }],
  transactionTypes: [{ transactioN_TYPE_ID: 18, transactioN_DESC: "Goods at standard rate (default)" }],
  unitsOfMeasure: [{ uoM_ID: 2, description: "KG" }],
};

function stubApi(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "/api/session": {
      secret: "test-secret",
      header: "x-fbr-session",
      mock: true,
      today: "2026-10-09",
      dataDir: "/tmp/fbr-di",
    },
    "/api/accounts": { accounts: [ACCOUNT] },
    "/api/submissions": { submissions: [], needsAttention: [] },
    "/api/reference": REFERENCE,
    "/api/scenarios": {
      eligible: [
        {
          id: "SN001",
          description: "Goods at standard rate to registered buyers",
          saleType: "Goods at Standard Rate (default)",
          expectedBuyerRegistrationType: "Registered",
          completed: true,
        },
        {
          id: "SN002",
          description: "Goods at standard rate to unregistered buyers",
          saleType: "Goods at Standard Rate (default)",
          expectedBuyerRegistrationType: "Unregistered",
          completed: false,
        },
      ],
      completedCount: 1,
    },
    ...overrides,
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://127.0.0.1:7345").pathname;
    const body = routes[path];
    if (body === undefined) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;

beforeEach(() => stubApi());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("App", () => {
  test("mounts and lands on the invoice screen when an account exists", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Invoice")).toBeTruthy());

    expect(screen.getByText("Buyer")).toBeTruthy();
    expect(screen.getByText("Item 1")).toBeTruthy();
  });

  test("starts on Settings when nothing is configured yet", async () => {
    // Otherwise a first-time user lands on an invoice form that cannot submit anything.
    stubApi({ "/api/accounts": { accounts: [] } });
    render(<App />);

    await waitFor(() => expect(screen.getByText("Seller accounts")).toBeTruthy());
    expect(screen.getByText("New account")).toBeTruthy();
  });

  test("shows the sandbox banner by default, and says nothing is filed for real", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/SANDBOX/)).toBeTruthy());
    expect(screen.getByText(/nothing is filed for real/i)).toBeTruthy();
  });

  test("switches the banner to a production warning", async () => {
    // The banner is the main guard against filing a real invoice by accident, since FBR has no
    // cancel API.
    render(<App />);
    await waitFor(() => expect(screen.getByText(/SANDBOX/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "production" } });

    await waitFor(() => expect(screen.getByText(/PRODUCTION/)).toBeTruthy());
    expect(screen.getByText(/filed for real/i)).toBeTruthy();
  });

  test("flags an account with no token for the selected environment", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/SANDBOX/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "production" } });

    // ACCOUNT has no production token, and submitting would fail — say so up front.
    await waitFor(() => expect(screen.getByText(/no production token saved/i)).toBeTruthy());
  });

  test("hides the scenario picker in production, where FBR refuses one", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Invoice")).toBeTruthy());
    expect(screen.getByText("Scenario")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "production" } });

    await waitFor(() => expect(screen.queryByText("Scenario")).toBeNull());
  });
});

describe("screens", () => {
  async function openTab(label: string | RegExp) {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Invoice")).toBeTruthy());
    fireEvent.click(screen.getByText(label));
  }

  test("scenario testing shows per-account progress", async () => {
    await openTab("Scenario testing");
    await waitFor(() => expect(screen.getByText(/1 of 2 passed/)).toBeTruthy());

    expect(screen.getByText("passed")).toBeTruthy();
    expect(screen.getByText("not yet")).toBeTruthy();
  });

  test("needs-checking is reassuring when there is nothing to reconcile", async () => {
    await openTab(/Needs checking/);
    await waitFor(() => expect(screen.getByText(/Nothing to check/i)).toBeTruthy());
  });

  test("settings lists the account and which tokens are saved", async () => {
    await openTab("Settings");
    await waitFor(() => expect(screen.getByText("Seller accounts")).toBeTruthy());

    // The label also appears in the account picker, so assert on the row's unique contents.
    expect(screen.getByText("0786909")).toBeTruthy();
    expect(screen.getByText("sandbox").className).toContain("done");
    expect(screen.getByText("production").className).toContain("todo");
  });

  test("reports a reference-data failure without blocking manual entry", async () => {
    // Losing FBR's lists shouldn't make the form unusable, but the user has to know the pickers
    // are empty for a reason.
    stubApi({ "/api/reference": undefined });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Couldn't load FBR's reference lists/i)).toBeTruthy());
    expect(screen.getByText("Invoice")).toBeTruthy();
  });
});
