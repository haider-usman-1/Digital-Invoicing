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

function template(scenarioId: string, registrationType: "Registered" | "Unregistered") {
  return {
    scenarioId,
    customised: false,
    verify: "Replace the buyer NTN with a genuinely registered one.",
    buyer: {
      ntncnic: "0788762",
      businessName: "Registered Buyer",
      province: "Punjab",
      address: "Lahore",
      registrationType,
    },
    item: {
      hsCode: "1006.3010",
      productDescription: "Basmati rice, semi-milled or wholly milled",
      uoM: "KG",
      quantity: 100,
      valueSalesExcludingST: 25000,
      rateDesc: "18%",
    },
  };
}

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
    "/api/rates": { rates: [{ ratE_ID: 413, ratE_DESC: "18%", ratE_VALUE: 18 }] },
    "/api/uom-for-hs": { unitsOfMeasure: [{ uoM_ID: 2, description: "KG" }] },
    "/api/scenarios": {
      eligible: [
        {
          id: "SN001",
          description: "Goods at standard rate to registered buyers",
          saleType: "Goods at Standard Rate (default)",
          expectedBuyerRegistrationType: "Registered",
          completed: true,
          template: template("SN001", "Registered"),
        },
        {
          id: "SN002",
          description: "Goods at standard rate to unregistered buyers",
          saleType: "Goods at Standard Rate (default)",
          expectedBuyerRegistrationType: "Unregistered",
          completed: false,
          template: template("SN002", "Unregistered"),
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

describe("field widths", () => {
  /** The wrapping .field div carries the width class. */
  function fieldOf(control: HTMLElement): HTMLElement {
    return control.closest(".field") as HTMLElement;
  }

  test("gives names, addresses and descriptions the full row", async () => {
    // These routinely run long, and the grid otherwise gives them the same box as a quantity.
    render(<App />);
    await waitFor(() => expect(screen.getByText("Buyer")).toBeTruthy());

    expect(fieldOf(screen.getByLabelText(/^Business name$/)).className).toContain("wide");
    expect(fieldOf(screen.getByLabelText(/^Address$/)).className).toContain("wide");
    expect(fieldOf(screen.getByLabelText(/^Description$/)).className).toContain("wide");
  });

  test("leaves short fields on the normal grid track", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Buyer")).toBeTruthy());

    expect(fieldOf(screen.getByLabelText(/^Quantity$/)).className).not.toContain("wide");
    expect(fieldOf(screen.getByLabelText(/^HS code$/)).className).not.toContain("wide");
  });

  test("does the same on the account form", async () => {
    stubApi({ "/api/accounts": { accounts: [] } });
    render(<App />);
    await waitFor(() => expect(screen.getByText("New account")).toBeTruthy());

    expect(fieldOf(screen.getByLabelText(/^Registered business name$/)).className).toContain("wide");
    expect(fieldOf(screen.getByLabelText(/^Address$/)).className).toContain("wide");
    expect(fieldOf(screen.getByLabelText(/^Province$/)).className).not.toContain("wide");
  });

  test("puts no length cap on those inputs", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Buyer")).toBeTruthy());

    for (const label of [/^Business name$/, /^Address$/, /^Description$/]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).maxLength).toBe(-1);
    }
  });
});

describe("value and unit price are interchangeable", () => {
  function amountFields() {
    return {
      value: screen.getByLabelText(/^Value excl\. sales tax$/) as HTMLInputElement,
      unitPrice: screen.getByLabelText(/^Unit price/) as HTMLInputElement,
      quantity: screen.getByLabelText(/^Quantity$/) as HTMLInputElement,
    };
  }

  test("typing a value backfills the unit price", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeTruthy());

    fireEvent.change(amountFields().quantity, { target: { value: "10" } });
    fireEvent.change(amountFields().value, { target: { value: "25000" } });

    await waitFor(() => expect(amountFields().unitPrice.value).toBe("2500.00"));
    // What was typed stays exactly as typed.
    expect(amountFields().value.value).toBe("25000");
  });

  test("typing a unit price fills in the value", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeTruthy());

    fireEvent.change(amountFields().quantity, { target: { value: "4" } });
    fireEvent.change(amountFields().unitPrice, { target: { value: "250" } });

    await waitFor(() => expect(amountFields().value.value).toBe("1000.00"));
  });

  test("keeps the typed value intact when it doesn't divide evenly", async () => {
    // The derived unit price is display only; filing 24999.99 instead of 25000 would earn FBR's
    // error 0104 on its own recalculation.
    render(<App />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeTruthy());

    fireEvent.change(amountFields().quantity, { target: { value: "3" } });
    fireEvent.change(amountFields().value, { target: { value: "25000" } });

    await waitFor(() => expect(amountFields().unitPrice.value).toBe("8333.33"));
    expect(amountFields().value.value).toBe("25000");
    expect(screen.getByText(/Value excl\. tax/)).toBeTruthy();
  });

  test("marks the derived side so it's clear which number the user owns", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeTruthy());

    fireEvent.change(amountFields().value, { target: { value: "25000" } });
    await waitFor(() => expect(amountFields().unitPrice.className).toContain("derived"));
    expect(amountFields().value.className).not.toContain("derived");

    // Switching direction swaps which one is marked.
    fireEvent.change(amountFields().unitPrice, { target: { value: "500" } });
    await waitFor(() => expect(amountFields().value.className).toContain("derived"));
    expect(amountFields().unitPrice.className).not.toContain("derived");
  });

  test("no longer treats the value as an 'edited' override", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Item 1")).toBeTruthy());

    fireEvent.change(amountFields().value, { target: { value: "25000" } });
    await waitFor(() => expect(amountFields().value.value).toBe("25000"));

    expect(amountFields().value.className).not.toContain("overridden");
    expect(screen.queryByText(/Value excl\. sales tax · edited/)).toBeNull();
  });
});

describe("starting a scenario", () => {
  async function startScenario() {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Invoice")).toBeTruthy());
    fireEvent.click(screen.getByText("Scenario testing"));
    await waitFor(() => expect(screen.getByText(/1 of 2 passed/)).toBeTruthy());
    fireEvent.click(screen.getAllByText("Start")[0]!);
    // Wait on real prefilled content, not the banner: the banner renders from the prop straight
    // away, while the prefill itself waits for FBR's reference lists to arrive.
    await waitFor(() =>
      expect((screen.getByLabelText(/^HS code$/) as HTMLInputElement).value).toBe("1006.3010"),
    );
  }

  test("lands on a form that is already filled in, not an empty one", async () => {
    // The entire point of the scenario screen. Prefilling only the sale type saved nothing.
    await startScenario();

    expect((screen.getByLabelText(/^HS code$/) as HTMLInputElement).value).toBe("1006.3010");
    expect((screen.getByLabelText(/^Unit of measure$/) as HTMLInputElement).value).toBe("KG");
    expect((screen.getByLabelText(/^Quantity$/) as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText(/^Value excl\. sales tax$/) as HTMLInputElement).value).toBe("25000");
    expect((screen.getByLabelText(/^Description$/) as HTMLInputElement).value).toMatch(/Basmati/);
  });

  test("fills in the buyer too", async () => {
    await startScenario();

    expect((screen.getByLabelText(/^Business name$/) as HTMLInputElement).value).toBe("Registered Buyer");
    expect((screen.getByLabelText(/NTN \/ CNIC/) as HTMLInputElement).value).toBe("0788762");
  });

  test("computes the tax from the prefilled values, so the form is submittable as-is", async () => {
    await startScenario();
    await waitFor(() =>
      expect((screen.getByLabelText(/^Sales tax$/) as HTMLInputElement).value).toBe("4500.00"),
    );
  });

  test("says the defaults are unverified and what to check", async () => {
    // These were never tested against FBR, and pretending otherwise would be dishonest.
    await startScenario();
    expect(screen.getByText(/never been checked against FBR/i)).toBeTruthy();
    expect(screen.getByText(/Replace the buyer NTN/i)).toBeTruthy();
  });

  test("offers to save corrections back to the template", async () => {
    await startScenario();
    expect(screen.getByText(/Save these values as the SN002 template/)).toBeTruthy();
  });

  test("shows no template banner on a plain invoice", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Invoice")).toBeTruthy());
    expect(screen.queryByText(/Prefilled from the/)).toBeNull();
    expect(screen.queryByText(/Save these values as/)).toBeNull();
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
