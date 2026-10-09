import { describe, expect, test } from "bun:test";
import { interpretPostResponse, interpretValidateResponse } from "../src/core/outcome.ts";
import type { FbrInvoiceResponse } from "../src/core/types.ts";

/**
 * Response fixtures are copied verbatim from PRAL Technical Specification v1.12 sections
 * 4.1.3 - 4.2.4. Do not "correct" the odd casing or the contradictory status codes: those
 * inconsistencies are exactly what these tests exist to pin down.
 */

const SPEC_POST_SUCCESS: FbrInvoiceResponse = {
  invoiceNumber: "7000007DI1747119701593",
  dated: "2025-05-13 12:01:41",
  validationResponse: {
    statusCode: "00",
    status: "Valid",
    error: "",
    invoiceStatuses: [
      {
        itemSNo: "1",
        statusCode: "00",
        status: "Valid",
        invoiceNo: "7000007DI1747119701593-1",
        errorCode: "",
        error: "",
      },
    ],
  },
};

/** Spec 4.1.4 — header-level rejection. Outer statusCode is "01" and there are no item statuses. */
const SPEC_POST_HEADER_REJECTION: FbrInvoiceResponse = {
  dated: "2025-05-13 13:09:05",
  validationResponse: {
    statusCode: "01",
    status: "Invalid",
    errorCode: "0052",
    error: "Provide proper HS Code with invoice no. null",
    invoiceStatuses: null,
  },
};

/**
 * Spec 4.1.5 — item-level rejection. THE TRAP: the outer statusCode is "00" (the same value a
 * success uses) and only the lowercase outer `status` and the item's own statusCode reveal the
 * failure. Trusting the outer statusCode here would report a filed invoice that does not exist.
 */
const SPEC_POST_ITEM_REJECTION: FbrInvoiceResponse = {
  dated: "2025-05-13 13:10:00",
  validationResponse: {
    statusCode: "00",
    status: "invalid",
    error: "",
    invoiceStatuses: [
      {
        itemSNo: "1",
        statusCode: "01",
        status: "Invalid",
        invoiceNo: null,
        errorCode: "0046",
        error: "Provide rate.",
      },
    ],
  },
};

describe("interpretPostResponse", () => {
  test("accepts the spec's success response and extracts the IRN", () => {
    const outcome = interpretPostResponse(SPEC_POST_SUCCESS);
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.irn).toBe("7000007DI1747119701593");
    expect(outcome.dated).toBe("2025-05-13 12:01:41");
  });

  test("rejects an item-level failure despite the outer statusCode being '00'", () => {
    const outcome = interpretPostResponse(SPEC_POST_ITEM_REJECTION);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]!.code).toBe("0046");
    expect(outcome.errors[0]!.itemSNo).toBe("1");
  });

  test("rejects a header-level failure and surfaces the outer error", () => {
    const outcome = interpretPostResponse(SPEC_POST_HEADER_REJECTION);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors[0]!.code).toBe("0052");
    expect(outcome.errors[0]!.itemSNo).toBeNull();
  });

  test("never reports success without an IRN, even if every status says Valid", () => {
    // Defensive: a success is only a success if we have the number that proves it. FBR omits the
    // key rather than nulling it, so the fixture does too.
    const { invoiceNumber, ...withoutIrn } = SPEC_POST_SUCCESS;
    expect(interpretPostResponse(withoutIrn).kind).not.toBe("success");
  });

  test("treats a blank IRN the same as a missing one", () => {
    const outcome = interpretPostResponse({ ...SPEC_POST_SUCCESS, invoiceNumber: "   " });
    expect(outcome.kind).not.toBe("success");
  });

  test("rejects when one item of several fails", () => {
    const outcome = interpretPostResponse({
      invoiceNumber: "7000007DI1747119701593",
      dated: "2025-05-13 12:01:41",
      validationResponse: {
        statusCode: "00",
        status: "Valid",
        invoiceStatuses: [
          { itemSNo: "1", statusCode: "00", status: "Valid", errorCode: "", error: "" },
          { itemSNo: "2", statusCode: "01", status: "Invalid", errorCode: "0099", error: "Provide UOM." },
        ],
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]!.itemSNo).toBe("2");
  });

  test("compares status case-insensitively, so 'VALID' is still valid", () => {
    const outcome = interpretPostResponse({
      invoiceNumber: "7000007DI1747119701593",
      validationResponse: {
        statusCode: "00",
        status: "VALID",
        invoiceStatuses: [{ itemSNo: "1", statusCode: "00", status: "VALID" }],
      },
    });
    expect(outcome.kind).toBe("success");
  });

  test("reports uncertain, not rejected, for an unreadable response shape", () => {
    // A proxy or gateway returning something unexpected must not be mistaken for a clean
    // rejection: the invoice may well have been filed.
    const outcome = interpretPostResponse({} as FbrInvoiceResponse);
    expect(outcome.kind).toBe("uncertain");
  });

  test("attaches a plain-language explanation to known error codes", () => {
    const outcome = interpretPostResponse(SPEC_POST_ITEM_REJECTION);
    if (outcome.kind !== "rejected") throw new Error("expected rejection");
    expect(outcome.errors[0]!.plain.length).toBeGreaterThan(0);
    expect(outcome.errors[0]!.plain).not.toBe(outcome.errors[0]!.code);
  });

  test("falls back to FBR's own text for an unrecognised error code", () => {
    const outcome = interpretPostResponse({
      validationResponse: {
        statusCode: "01",
        status: "Invalid",
        errorCode: "9999",
        error: "Something new FBR invented",
        invoiceStatuses: null,
      },
    });
    if (outcome.kind !== "rejected") throw new Error("expected rejection");
    expect(outcome.errors[0]!.plain).toContain("Something new FBR invented");
  });

  test("still rejects when a failing item carries no error code at all", () => {
    const outcome = interpretPostResponse({
      validationResponse: {
        statusCode: "00",
        status: "invalid",
        invoiceStatuses: [{ itemSNo: "1", statusCode: "01", status: "Invalid" }],
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors).toHaveLength(1);
  });
});

describe("interpretValidateResponse", () => {
  /** Spec 4.2.3 — note there is no `invoiceNumber`, and items have no `invoiceNo` key. */
  test("accepts the spec's valid response", () => {
    const outcome = interpretValidateResponse({
      dated: "2025-05-13 13:13:07",
      validationResponse: {
        statusCode: "00",
        status: "Valid",
        errorCode: null,
        error: "",
        invoiceStatuses: [
          { itemSNo: "1", statusCode: "00", status: "Valid", errorCode: null, error: "" },
        ],
      },
    });
    expect(outcome.kind).toBe("valid");
  });

  test("does not require an IRN, unlike a post", () => {
    // The whole point: validate never returns an invoiceNumber, so requiring one would make
    // every pre-flight check fail and no invoice would ever be submitted.
    const outcome = interpretValidateResponse({
      validationResponse: {
        statusCode: "00",
        status: "Valid",
        invoiceStatuses: [{ itemSNo: "1", statusCode: "00", status: "Valid" }],
      },
    });
    expect(outcome.kind).toBe("valid");
  });

  test("rejects the spec's invalid response where outer statusCode is still '00'", () => {
    const outcome = interpretValidateResponse({
      dated: "2025-05-13 13:13:07",
      validationResponse: {
        statusCode: "00",
        status: "Invalid",
        errorCode: null,
        error: "",
        invoiceStatuses: [
          { itemSNo: "1", statusCode: "01", status: "Invalid", errorCode: "0046", error: "Provide rate." },
        ],
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors[0]!.code).toBe("0046");
  });

  test("reports uncertain for an unreadable response shape", () => {
    expect(interpretValidateResponse({} as FbrInvoiceResponse).kind).toBe("uncertain");
  });
});
