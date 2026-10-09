import { useCallback, useEffect, useMemo, useState } from "react";
import { api, currentSession } from "./api.ts";
import { Field } from "./Settings.tsx";
import { Dialog, Spinner, StatusDot } from "./Dialog.tsx";
import { computeLine, round2 } from "../core/calc.ts";
import { SCENARIOS, expectedBuyerRegistrationType, findScenario } from "../core/scenarios.ts";
import type { UiAccount } from "./App.tsx";
import { HS_CODE_PATTERN } from "../core/types.ts";
import type {
  BuyerRegistrationType,
  Env,
  FbrInvoiceItem,
  HsCode,
  Province,
  SaleTypeRate,
  TransactionType,
  UnitOfMeasure,
} from "../core/types.ts";

/**
 * The amounts the user may override.
 *
 * `valueSalesExcludingST` is deliberately NOT here: it is a primary input the user can type
 * directly, so flagging it as "edited" would imply they were correcting a mistake.
 */
const OVERRIDABLE = [
  "salesTaxApplicable",
  "totalValues",
  "furtherTax",
  "extraTax",
  "fedPayable",
  "salesTaxWithheldAtSource",
] as const;

type Overridable = (typeof OVERRIDABLE)[number];

interface ItemDraft {
  key: string;
  hsCode: string;
  productDescription: string;
  transTypeId: number | null;
  rateDesc: string;
  uoM: string;
  quantity: string;
  unitPrice: string;
  /** Sales value excluding tax, when the line is driven this way round. */
  value: string;
  /** Whichever of the two the user last typed in. That one is authoritative. */
  amountBasis: "unitPrice" | "value";
  discount: string;
  retailPrice: string;
  overrides: Partial<Record<Overridable, string>>;
}

/** A scenario template as the server resolves it: built-in default, or the user's saved version. */
export interface ScenarioTemplateData {
  scenarioId: string;
  customised: boolean;
  verify?: string;
  buyer: {
    ntncnic: string;
    businessName: string;
    province: string;
    address: string;
    registrationType: BuyerRegistrationType;
  };
  item: {
    hsCode: string;
    productDescription: string;
    uoM: string;
    quantity: number;
    valueSalesExcludingST: number;
    rateDesc: string;
    retailPrice?: number;
    furtherTax?: number;
    extraTax?: number;
    fedPayable?: number;
    salesTaxWithheldAtSource?: number;
  };
}

/**
 * The per-HS-code unit lookup.
 *
 * Failure is a state rather than a silent fallback: FBR rejects a mismatched unit with error 0099,
 * so quietly offering all 44 units when the restriction could not be fetched hands the user a
 * rejection instead of an explanation.
 */
type UomLookup =
  | { status: "loading" }
  | { status: "ready"; options: UnitOfMeasure[] }
  | { status: "error"; message: string };

interface Reference {
  provinces: Province[];
  hsCodes: HsCode[];
  transactionTypes: TransactionType[];
  unitsOfMeasure: UnitOfMeasure[];
}

type SubmitResult =
  | { status: "success"; irn: string; dated: string | null }
  | { status: "rejected"; stage: "precheck" | "filing"; errors: Array<{ plain: string; itemSNo: string | null; field: string | null }> }
  | { status: "uncertain"; reason: string; portalSearch: Record<string, string | number> }
  | { status: "error"; message: string };

/** A check never files, so it has no IRN and no uncertain state. */
type CheckResult =
  | { status: "valid" }
  | { status: "rejected"; errors: Array<{ plain: string; itemSNo: string | null; field: string | null }> }
  | { status: "error"; message: string };

function blankItem(): ItemDraft {
  return {
    key: crypto.randomUUID(),
    hsCode: "",
    productDescription: "",
    transTypeId: null,
    rateDesc: "",
    uoM: "",
    quantity: "1",
    unitPrice: "",
    value: "",
    amountBasis: "value",
    discount: "0",
    retailPrice: "",
    overrides: {},
  };
}

const num = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Matches a scenario's sale type against the live reference list, case-insensitively.
 *
 * FBR's own documents disagree on casing: the scenario table says "Goods at Standard Rate
 * (default)" while the payload sample sends "Goods at standard rate (default)". The reference
 * endpoint is the source of truth for what goes on the wire, so we look the name up there.
 */
function matchTransactionType(types: TransactionType[], saleType: string): TransactionType | undefined {
  const needle = saleType.trim().toLowerCase();
  return types.find((t) => t.transactioN_DESC.trim().toLowerCase() === needle);
}

export function NewInvoice({
  account,
  env,
  onSubmitted,
  initialScenarioId,
  template,
}: {
  account: UiAccount | null;
  env: Env;
  onSubmitted: () => void;
  initialScenarioId?: string;
  /** Present when the form was opened from the scenario screen, to be filled in ready to file. */
  template?: ScenarioTemplateData;
}) {
  const [reference, setReference] = useState<Reference | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const [invoiceDate, setInvoiceDate] = useState(currentSession().today);
  const [internalInvoiceNumber, setInternalInvoiceNumber] = useState("");
  const [scenarioId, setScenarioId] = useState(initialScenarioId ?? "");

  const [buyer, setBuyer] = useState({
    ntncnic: "",
    businessName: "",
    province: "",
    address: "",
    registrationType: "Unregistered" as BuyerRegistrationType,
  });
  const [buyerLookup, setBuyerLookup] = useState<string | null>(null);

  const [items, setItems] = useState<ItemDraft[]>([blankItem()]);
  const [ratesByType, setRatesByType] = useState<Record<number, SaleTypeRate[]>>({});
  const [uomByHs, setUomByHs] = useState<Record<string, UomLookup>>({});

  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [templateSaved, setTemplateSaved] = useState<string | null>(null);

  // --- Reference data ------------------------------------------------------

  useEffect(() => {
    if (!account) return;
    setReference(null);
    setReferenceError(null);

    api
      .get<Reference>(`/api/reference?accountId=${account.id}&env=${env}`)
      .then(setReference)
      .catch((e: unknown) => setReferenceError(e instanceof Error ? e.message : String(e)));
  }, [account, env]);

  const loadRates = useCallback(
    async (transTypeId: number) => {
      if (!account || ratesByType[transTypeId]) return;
      try {
        const { rates } = await api.get<{ rates: SaleTypeRate[] }>(
          `/api/rates?accountId=${account.id}&env=${env}&transTypeId=${transTypeId}&date=${invoiceDate}`,
        );
        setRatesByType((current) => ({ ...current, [transTypeId]: rates }));
      } catch {
        // Leaving the rate list empty is honest: the user can still type the rate FBR expects.
      }
    },
    [account, env, invoiceDate, ratesByType],
  );

  const loadUom = useCallback(
    async (hsCode: string) => {
      // Only ask once the code is complete. Firing on every keystroke sent FBR a request per
      // character — ten round-trips to type one code, each answered with an empty list.
      if (!account || !HS_CODE_PATTERN.test(hsCode) || uomByHs[hsCode]) return;

      setUomByHs((current) => ({ ...current, [hsCode]: { status: "loading" } }));
      try {
        const { unitsOfMeasure } = await api.get<{ unitsOfMeasure: UnitOfMeasure[] }>(
          `/api/uom-for-hs?accountId=${account.id}&env=${env}&hsCode=${encodeURIComponent(hsCode)}`,
        );
        setUomByHs((current) => ({
          ...current,
          [hsCode]: { status: "ready", options: unitsOfMeasure },
        }));
      } catch (e) {
        setUomByHs((current) => ({
          ...current,
          [hsCode]: { status: "error", message: e instanceof Error ? e.message : String(e) },
        }));
      }
    },
    [account, env, uomByHs],
  );

  // --- Scenario prefill ----------------------------------------------------

  const applyScenario = useCallback(
    (id: string) => {
      setScenarioId(id);
      const scenario = findScenario(id);
      if (!scenario || !reference) return;

      // The scenario fixes the sale type, and for retail/unregistered scenarios the buyer's
      // registration type too — getting that wrong earns error 0012 or 0053.
      setBuyer((b) => ({ ...b, registrationType: expectedBuyerRegistrationType(id) }));

      const type = matchTransactionType(reference.transactionTypes, scenario.saleType);
      if (!type) return;

      void loadRates(type.transactioN_TYPE_ID);
      setItems((current) =>
        current.map((item) => ({ ...item, transTypeId: type.transactioN_TYPE_ID, rateDesc: "" })),
      );
    },
    [reference, loadRates],
  );

  /**
   * Fills the whole form from a scenario template.
   *
   * Distinct from `applyScenario`, which the dropdown on this screen uses: that only tags the
   * invoice with a scenario and must not overwrite what the user has typed. Arriving from the
   * scenario screen is the opposite — the entire point is to land on a form that is ready to file.
   */
  const applyTemplate = useCallback(
    (id: string, tpl: ScenarioTemplateData) => {
      if (!reference) return;
      setScenarioId(id);
      setBuyer({ ...tpl.buyer });

      const scenario = findScenario(id);
      const type = scenario
        ? matchTransactionType(reference.transactionTypes, scenario.saleType)
        : undefined;
      if (type) void loadRates(type.transactioN_TYPE_ID);
      if (tpl.item.hsCode) void loadUom(tpl.item.hsCode);

      const amount = (value: number | undefined) => (value ? String(value) : "");

      setItems([
        {
          ...blankItem(),
          transTypeId: type?.transactioN_TYPE_ID ?? null,
          hsCode: tpl.item.hsCode,
          productDescription: tpl.item.productDescription,
          uoM: tpl.item.uoM,
          rateDesc: tpl.item.rateDesc,
          quantity: String(tpl.item.quantity),
          value: String(tpl.item.valueSalesExcludingST),
          amountBasis: "value",
          retailPrice: amount(tpl.item.retailPrice),
          // Taxes the template specifies are seeded as overrides, since they cannot be derived.
          overrides: {
            ...(tpl.item.furtherTax ? { furtherTax: String(tpl.item.furtherTax) } : {}),
            ...(tpl.item.extraTax ? { extraTax: String(tpl.item.extraTax) } : {}),
            ...(tpl.item.fedPayable ? { fedPayable: String(tpl.item.fedPayable) } : {}),
            ...(tpl.item.salesTaxWithheldAtSource
              ? { salesTaxWithheldAtSource: String(tpl.item.salesTaxWithheldAtSource) }
              : {}),
          },
        },
      ]);
    },
    [reference, loadRates, loadUom],
  );

  useEffect(() => {
    if (!reference || !initialScenarioId) return;
    if (template) applyTemplate(initialScenarioId, template);
    else applyScenario(initialScenarioId);
    // Runs once per incoming scenario, after reference data lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScenarioId, reference]);

  // --- Computation ---------------------------------------------------------

  const computed = useMemo(
    () =>
      items.map((item) => {
        const type = reference?.transactionTypes.find((t) => t.transactioN_TYPE_ID === item.transTypeId);
        const rates = item.transTypeId !== null ? (ratesByType[item.transTypeId] ?? []) : [];
        const rate: SaleTypeRate =
          rates.find((r) => r.ratE_DESC === item.rateDesc) ??
          // An unknown rate string is still sent verbatim; we just can't compute from it.
          ({ ratE_ID: -1, ratE_DESC: item.rateDesc, ratE_VALUE: 0 } satisfies SaleTypeRate);

        const base = computeLine({
          quantity: num(item.quantity),
          amount:
            item.amountBasis === "unitPrice"
              ? { basis: "unitPrice", unitPrice: num(item.unitPrice) }
              : { basis: "value", valueSalesExcludingST: num(item.value) },
          discount: num(item.discount),
          rate,
          saleType: type?.transactioN_DESC ?? "",
          retailPrice: num(item.retailPrice),
        });

        const applied = { ...base };
        for (const field of OVERRIDABLE) {
          const override = item.overrides[field];
          if (override !== undefined && override !== "") applied[field] = round2(num(override));
        }

        return { base, applied, saleTypeDesc: type?.transactioN_DESC ?? "", rates };
      }),
    [items, reference, ratesByType],
  );

  /** HS code -> description, so a typed code can be confirmed without another request. */
  const hsIndex = useMemo(
    () => new Map((reference?.hsCodes ?? []).map((h) => [h.hS_CODE, h.description])),
    [reference],
  );

  const totals = useMemo(() => {
    const value = computed.reduce((sum, c) => sum + c.applied.valueSalesExcludingST, 0);
    const tax = computed.reduce(
      (sum, c) => sum + c.applied.salesTaxApplicable + c.applied.furtherTax + c.applied.extraTax,
      0,
    );
    return { value: round2(value), tax: round2(tax), total: round2(value + tax) };
  }, [computed]);

  const warnings = computed.flatMap((c, index) =>
    c.base.warnings.map((text) => ({ index: index + 1, text })),
  );

  // --- Submission ----------------------------------------------------------

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  /** The request body both actions send, so a check can never test something different. */
  function invoiceRequest() {
    const payloadItems: FbrInvoiceItem[] = items.map((item, index) => {
      const { applied, saleTypeDesc } = computed[index]!;
      return {
        hsCode: item.hsCode,
        productDescription: item.productDescription,
        rate: applied.rate,
        uoM: item.uoM,
        quantity: num(item.quantity),
        totalValues: applied.totalValues,
        valueSalesExcludingST: applied.valueSalesExcludingST,
        fixedNotifiedValueOrRetailPrice: applied.fixedNotifiedValueOrRetailPrice,
        salesTaxApplicable: applied.salesTaxApplicable,
        salesTaxWithheldAtSource: applied.salesTaxWithheldAtSource,
        extraTax: applied.extraTax,
        furtherTax: applied.furtherTax,
        sroScheduleNo: "",
        fedPayable: applied.fedPayable,
        discount: applied.discount,
        saleType: saleTypeDesc,
        sroItemSerialNo: "",
      };
    });

    return {
      accountId: account!.id,
      env,
      buyer,
      invoiceDate,
      internalInvoiceNumber,
      ...(env === "sandbox" && scenarioId ? { scenarioId } : {}),
      items: payloadItems,
    };
  }

  async function submit() {
    if (!account) return;
    setSubmitting(true);
    setResult(null);
    setCheckResult(null);

    try {
      setResult(await api.post<SubmitResult>("/api/invoice/submit", invoiceRequest()));
      onSubmitted();
    } catch (e) {
      setResult({ status: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Asks FBR whether the invoice would be accepted, without filing it.
   *
   * Nothing is recorded by FBR or logged here, so this is free to repeat — useful for working
   * through a scenario's rejections, and for a dry run before an irreversible production filing.
   */
  async function check() {
    if (!account) return;
    setChecking(true);
    setResult(null);
    setCheckResult(null);

    try {
      setCheckResult(await api.post<CheckResult>("/api/invoice/validate", invoiceRequest()));
    } catch (e) {
      setCheckResult({ status: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }

  /**
   * Writes the current form back over the scenario's template.
   *
   * This is what makes the shipped defaults safe to guess at: FBR validates HS code, unit of
   * measure and rate combinations server-side and none of them could be verified without a
   * sandbox token, so the first account through a scenario corrects it and every account after
   * inherits the fix.
   */
  async function storeTemplate() {
    if (!template || !scenarioId) return;
    const item = items[0];
    const applied = computed[0]?.applied;
    if (!item || !applied) return;

    try {
      await api.post(`/api/scenario-templates/${scenarioId}`, {
        buyer,
        item: {
          hsCode: item.hsCode,
          productDescription: item.productDescription,
          uoM: item.uoM,
          rateDesc: item.rateDesc,
          quantity: num(item.quantity),
          valueSalesExcludingST: applied.valueSalesExcludingST,
          ...(num(item.retailPrice) ? { retailPrice: num(item.retailPrice) } : {}),
          ...(applied.furtherTax ? { furtherTax: applied.furtherTax } : {}),
          ...(applied.extraTax ? { extraTax: applied.extraTax } : {}),
          ...(applied.fedPayable ? { fedPayable: applied.fedPayable } : {}),
          ...(applied.salesTaxWithheldAtSource
            ? { salesTaxWithheldAtSource: applied.salesTaxWithheldAtSource }
            : {}),
        },
      });
      setTemplateSaved(`Saved. Every account will now start ${scenarioId} from these values.`);
    } catch (e) {
      setTemplateSaved(e instanceof Error ? e.message : String(e));
    }
  }

  async function resetTemplateToDefault() {
    if (!scenarioId) return;
    try {
      const { template: fresh } = await api.delete<{ template: ScenarioTemplateData }>(
        `/api/scenario-templates/${scenarioId}`,
      );
      applyTemplate(scenarioId, fresh);
      setTemplateSaved(`${scenarioId} is back to its built-in starting values.`);
    } catch (e) {
      setTemplateSaved(e instanceof Error ? e.message : String(e));
    }
  }

  async function lookupBuyer() {
    if (!account) return;
    setBuyerLookup("Checking…");
    try {
      const { registrationType } = await api.post<{ registrationType: BuyerRegistrationType }>(
        "/api/buyer-lookup",
        { accountId: account.id, env, registrationNo: buyer.ntncnic },
      );
      setBuyer((b) => ({ ...b, registrationType }));
      setBuyerLookup(`FBR says: ${registrationType}`);
    } catch (e) {
      setBuyerLookup(e instanceof Error ? e.message : String(e));
    }
  }

  // --- Render --------------------------------------------------------------

  if (!account) {
    return (
      <div className="note warn">
        <strong>No account selected</strong>
        <span>Add a seller account in Settings first.</span>
      </div>
    );
  }

  const rejected =
    result?.status === "rejected" ? result.errors : checkResult?.status === "rejected" ? checkResult.errors : [];
  const fieldErrors = new Set(rejected.map((e) => e.field).filter(Boolean));

  const busy = submitting || checking;
  const dialogOpen = busy || result !== null || checkResult !== null;

  function closeDialog() {
    setResult(null);
    setCheckResult(null);
  }

  return (
    <>
      {referenceError && (
        <div className="note warn">
          <strong>Couldn't load FBR's reference lists</strong>
          <span>{referenceError}</span>
          <span>You can still type values in by hand, but they have to match FBR's wording exactly.</span>
        </div>
      )}

      {template && (
        <div className="note warn">
          <strong>
            Prefilled from the {template.scenarioId} template
            {template.customised ? " (your saved version)" : " (built-in starting values)"}
          </strong>
          {!template.customised && (
            <span>
              These defaults have never been checked against FBR. If it rejects something, fix it
              here and save it back — every account after this one will start from the corrected
              version.
            </span>
          )}
          {template.verify && <span>{template.verify}</span>}
          <div className="actions">
            <button className="small" onClick={() => void storeTemplate()}>
              Save these values as the {template.scenarioId} template
            </button>
            {template.customised && (
              <button className="link" onClick={() => void resetTemplateToDefault()}>
                reset to built-in values
              </button>
            )}
          </div>
        </div>
      )}

      {templateSaved && <div className="note ok">{templateSaved}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Invoice</h2>
          <span className="hint">Seller: {account.sellerBusinessName || account.label}</span>
        </div>
        <div className="card-body">
          <div className="grid">
            <Field label="Invoice date" hint="Pakistan date.">
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </Field>

            <Field label="Your invoice number" hint="Kept on this machine; FBR issues its own number.">
              <input
                value={internalInvoiceNumber}
                onChange={(e) => setInternalInvoiceNumber(e.target.value)}
                placeholder="ACME-2026-0001"
              />
            </Field>

            {env === "sandbox" && (
              <Field label="Scenario" span={6} hint="Required by FBR for every sandbox invoice.">
                <select value={scenarioId} onChange={(e) => applyScenario(e.target.value)}>
                  <option value="">Choose a scenario…</option>
                  {(account.eligibleScenarios.length > 0
                    ? SCENARIOS.filter((s) => account.eligibleScenarios.includes(s.id))
                    : SCENARIOS
                  ).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id} — {s.description}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Buyer</h2>
        </div>
        <div className="card-body">
          <div className="grid">
            <Field label="NTN / CNIC" span={4} hint="Leave blank if the buyer is unregistered.">
              <div className="field-row">
                <input
                  className={fieldErrors.has("buyerNTNCNIC") ? "invalid" : undefined}
                  value={buyer.ntncnic}
                  inputMode="numeric"
                  onChange={(e) => setBuyer({ ...buyer, ntncnic: e.target.value })}
                />
                <button className="small" onClick={() => void lookupBuyer()} disabled={!buyer.ntncnic.trim()}>
                  Check
                </button>
              </div>
            </Field>

            <Field label="Registration type" span={4} {...(buyerLookup ? { hint: buyerLookup } : {})}>
              <select
                className={fieldErrors.has("buyerRegistrationType") ? "invalid" : undefined}
                value={buyer.registrationType}
                onChange={(e) =>
                  setBuyer({ ...buyer, registrationType: e.target.value as BuyerRegistrationType })
                }
              >
                <option value="Registered">Registered</option>
                <option value="Unregistered">Unregistered</option>
              </select>
            </Field>

            <Field label="Province" span={4}>
              <input
                className={fieldErrors.has("buyerProvince") ? "invalid" : undefined}
                list="provinces"
                value={buyer.province}
                onChange={(e) => setBuyer({ ...buyer, province: e.target.value })}
              />
              <datalist id="provinces">
                {reference?.provinces.map((p) => (
                  <option key={p.stateProvinceCode} value={p.stateProvinceDesc} />
                ))}
              </datalist>
            </Field>

            <Field label="Business name" wide>
              <input
                className={fieldErrors.has("buyerBusinessName") ? "invalid" : undefined}
                value={buyer.businessName}
                onChange={(e) => setBuyer({ ...buyer, businessName: e.target.value })}
              />
            </Field>

            <Field label="Address" wide>
              <input value={buyer.address} onChange={(e) => setBuyer({ ...buyer, address: e.target.value })} />
            </Field>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Line items</h2>
          <span className="hint">{items.length === 1 ? "1 item" : `${items.length} items`}</span>
          <span className="spacer" />
          <button className="small" onClick={() => setItems((current) => [...current, blankItem()])}>
            Add another item
          </button>
        </div>
        <div className="card-body">
          {items.map((item, index) => (
            <ItemCard
              key={item.key}
              index={index}
              item={item}
              computed={computed[index]!}
              reference={reference}
              uomLookup={uomByHs[item.hsCode.trim()]}
              allUnits={reference?.unitsOfMeasure ?? []}
              hsIndex={hsIndex}
              referenceLoaded={reference !== null}
              removable={items.length > 1}
              fieldErrors={fieldErrors}
              onChange={(patch) => updateItem(item.key, patch)}
              onRemove={() => setItems((current) => current.filter((i) => i.key !== item.key))}
              onSaleTypeChosen={(id) => void loadRates(id)}
              onHsCodeChosen={(code) => void loadUom(code)}
            />
          ))}

          {warnings.length > 0 && (
            <div className="note warn">
              <strong>Check these before submitting</strong>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>
                    Item {w.index}: {w.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/*
        * Sticky, so the controls and the running totals stay with the user down a long form.
        * The result arrives in a modal rather than at the top of the page, because feedback the
        * user has to go looking for is feedback they may click through twice.
        */}
      <div className="action-bar">
        <div className="totals">
          <div>
            <span>Value excl. tax</span>
            <span>{totals.value.toFixed(2)}</span>
          </div>
          <div>
            <span>Tax</span>
            <span>{totals.tax.toFixed(2)}</span>
          </div>
          <div>
            <span>Total</span>
            <span>{totals.total.toFixed(2)}</span>
          </div>
        </div>

        <div className="actions">
          <button onClick={() => void check()} disabled={busy}>
            {checking ? "Checking…" : "Check without filing"}
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {submitting
              ? "Sending to FBR…"
              : env === "production"
                ? "File this invoice with FBR"
                : "Submit to sandbox"}
          </button>
        </div>
      </div>

      {dialogOpen && (
        <SubmissionDialog
          env={env}
          busy={busy}
          submitting={submitting}
          result={result}
          checkResult={checkResult}
          onClose={closeDialog}
        />
      )}
    </>
  );
}

/**
 * Everything the user learns about a submission, in one modal.
 *
 * While the request is in flight the dialog refuses to close, which is the point: the previous
 * layout put the button at the bottom of a long form and its result at the top, so after clicking
 * you could not tell whether anything had happened. With no idempotency key at FBR, that
 * uncertainty is what produces a duplicate filing.
 */
function SubmissionDialog({
  env,
  busy,
  submitting,
  result,
  checkResult,
  onClose,
}: {
  env: Env;
  busy: boolean;
  submitting: boolean;
  result: SubmitResult | null;
  checkResult: CheckResult | null;
  onClose: () => void;
}) {
  const title = busy
    ? submitting
      ? env === "production"
        ? "Filing with FBR"
        : "Submitting to sandbox"
      : "Checking with FBR"
    : result
      ? {
          success: "Invoice filed",
          rejected: "Invoice rejected",
          uncertain: "Outcome unknown",
          error: "Couldn't submit",
        }[result.status]
      : checkResult
        ? { valid: "Pre-check passed", rejected: "Pre-check failed", error: "Couldn't check" }[
            checkResult.status
          ]
        : "";

  const tone: "ok" | "warn" | "error" =
    result?.status === "success" || checkResult?.status === "valid"
      ? "ok"
      : result?.status === "uncertain"
        ? "warn"
        : "error";

  const irn = result?.status === "success" ? result.irn : null;

  return (
    <Dialog
      title={title}
      busy={busy}
      onClose={onClose}
      icon={busy ? <Spinner /> : <StatusDot tone={tone} />}
      footer={
        busy ? (
          <span className="hint">This usually takes a few seconds. Please don't close the app.</span>
        ) : (
          <>
            {irn && (
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(irn);
                }}
              >
                Copy invoice number
              </button>
            )}
            <span className="spacer" />
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      {busy ? (
        <span className="hint">
          {submitting
            ? "Waiting for FBR to accept the invoice. Don't submit again — if this times out the app will tell you exactly what to check."
            : "Asking FBR whether it would accept this invoice. Nothing is being filed."}
        </span>
      ) : checkResult ? (
        <CheckPanel result={checkResult} />
      ) : result ? (
        <ResultPanel result={result} />
      ) : null}
    </Dialog>
  );
}

function ItemCard({
  index,
  item,
  computed,
  reference,
  uomLookup,
  allUnits,
  hsIndex,
  referenceLoaded,
  removable,
  fieldErrors,
  onChange,
  onRemove,
  onSaleTypeChosen,
  onHsCodeChosen,
}: {
  index: number;
  item: ItemDraft;
  computed: { base: ReturnType<typeof computeLine>; applied: ReturnType<typeof computeLine>; rates: SaleTypeRate[] };
  reference: Reference | null;
  uomLookup: UomLookup | undefined;
  allUnits: UnitOfMeasure[];
  hsIndex: Map<string, string>;
  referenceLoaded: boolean;
  removable: boolean;
  fieldErrors: Set<string | null>;
  onChange: (patch: Partial<ItemDraft>) => void;
  onRemove: () => void;
  onSaleTypeChosen: (transTypeId: number) => void;
  onHsCodeChosen: (hsCode: string) => void;
}) {
  const hsCode = item.hsCode.trim();
  const hsComplete = HS_CODE_PATTERN.test(hsCode);
  const hsDescription = hsComplete ? hsIndex.get(hsCode) : undefined;
  /*
   * Only question a code when we are holding FBR's real catalogue.
   *
   * In mock mode the list is a handful of fixtures, so every genuine code looks unknown — which is
   * exactly how 2942.0000, a code from a successfully filed production invoice, got flagged. And
   * even live this is a soft signal: the cached list can be stale, so it is styled as a doubt
   * rather than in the red reserved for something FBR has actually rejected.
   */
  const hsUnknown =
    hsComplete && referenceLoaded && !currentSession().mock && hsDescription === undefined;

  /**
   * Suggestions for the typed prefix, capped.
   *
   * The datalist previously held every code FBR publishes, per line item — 7,809 option elements
   * each, for a list the browser truncates anyway.
   */
  const hsSuggestions = useMemo(() => {
    const query = hsCode.replace(/\s/g, "");
    if (query.length < 2) return [];
    const matches: Array<{ hS_CODE: string; description: string }> = [];
    for (const code of reference?.hsCodes ?? []) {
      if (code.hS_CODE.startsWith(query)) matches.push(code);
      if (matches.length === 25) break;
    }
    return matches;
  }, [hsCode, reference]);

  const restricted = uomLookup?.status === "ready" ? uomLookup.options : null;
  const singleUnit = restricted?.length === 1 ? restricted[0]!.description : null;

  // FBR usually permits exactly one unit for a code; filling it in is the whole point of asking.
  useEffect(() => {
    if (singleUnit && item.uoM === "") onChange({ uoM: singleUnit });
  }, [singleUnit, item.uoM]);

  const isThirdSchedule = /3rd\s*schedule/i.test(
    reference?.transactionTypes.find((t) => t.transactioN_TYPE_ID === item.transTypeId)?.transactioN_DESC ?? "",
  );

  const override = (field: Overridable, value: string) =>
    onChange({ overrides: { ...item.overrides, [field]: value } });

  return (
    <div className="item">
      <div className="item-head">
        <span>Item {index + 1}</span>
        {computed.base.confidence === "low" && <span className="pill unsure">check the amounts</span>}
        <div className="spacer" />
        {removable && (
          <button className="small danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>

      <div className="item-body">
      <div className="grid">
        <Field
          label="HS code"
          span={3}
          hint={
            hsUnknown
              ? "Not in the HS code list FBR returned — worth double-checking."
              : hsDescription
                ? hsDescription
                : "Type a full code, e.g. 2942.0000."
          }
          hintTone={hsUnknown ? "warn" : undefined}
        >
          <input
            className={[fieldErrors.has("hsCode") ? "invalid" : "", hsUnknown ? "suspect" : ""]
              .filter(Boolean)
              .join(" ")}
            list={`hs-${item.key}`}
            value={item.hsCode}
            onChange={(e) => {
              onChange({ hsCode: e.target.value });
              onHsCodeChosen(e.target.value);
            }}
            placeholder="0101.2100"
          />
          {/*
            * Suggestions are filtered to what has been typed and capped. Emitting all 7,809 codes
            * per line item put tens of thousands of nodes in the document for no benefit — the
            * browser shows only a handful anyway.
            */}
          <datalist id={`hs-${item.key}`}>
            {hsSuggestions.map((h) => (
              <option key={h.hS_CODE} value={h.hS_CODE}>
                {h.description}
              </option>
            ))}
          </datalist>
        </Field>


        <Field label="Sale type" span={3}>
          <select
            className={fieldErrors.has("saleType") ? "invalid" : undefined}
            value={item.transTypeId ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value);
              onChange({ transTypeId: Number.isFinite(id) ? id : null, rateDesc: "" });
              if (Number.isFinite(id)) onSaleTypeChosen(id);
            }}
          >
            <option value="">Choose…</option>
            {reference?.transactionTypes.map((t) => (
              <option key={t.transactioN_TYPE_ID} value={t.transactioN_TYPE_ID}>
                {t.transactioN_DESC}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Rate" span={3} hint={computed.rates.length === 0 ? "Pick a sale type to load rates." : undefined}>
          <select
            className={fieldErrors.has("rate") ? "invalid" : undefined}
            value={item.rateDesc}
            onChange={(e) => onChange({ rateDesc: e.target.value })}
          >
            <option value="">Choose…</option>
            {computed.rates.map((r) => (
              <option key={r.ratE_ID} value={r.ratE_DESC}>
                {r.ratE_DESC}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Unit of measure"
          span={3}
          hint={
            uomLookup?.status === "loading"
              ? "Asking FBR which units this HS code allows…"
              : uomLookup?.status === "error"
                ? `Couldn't load the allowed units (${uomLookup.message}). Any unit FBR doesn't allow is rejected with error 0099.`
                : restricted
                  ? restricted.length === 1
                    ? "The only unit FBR allows for this HS code."
                    : `FBR allows ${restricted.length} units for this HS code.`
                  : "Enter a full HS code to see which units FBR allows."
          }
        >
          {/*
            * A select once the restriction is known, because a datalist only suggests: it never
            * constrains and never fills anything in, so a single allowed unit looked like nothing
            * had happened at all.
            */}
          {restricted && restricted.length > 0 ? (
            <select
              className={fieldErrors.has("uoM") ? "invalid" : undefined}
              value={item.uoM}
              onChange={(e) => onChange({ uoM: e.target.value })}
            >
              <option value="">Choose…</option>
              {restricted.map((u) => (
                <option key={u.uoM_ID} value={u.description}>
                  {u.description}
                </option>
              ))}
              {/* Keep a value FBR no longer lists visible rather than silently dropping it. */}
              {item.uoM !== "" && !restricted.some((u) => u.description === item.uoM) && (
                <option value={item.uoM}>{item.uoM} (not allowed for this HS code)</option>
              )}
            </select>
          ) : (
            <>
              <input
                className={fieldErrors.has("uoM") ? "invalid" : undefined}
                list={`uom-${item.key}`}
                value={item.uoM}
                onChange={(e) => onChange({ uoM: e.target.value })}
              />
              <datalist id={`uom-${item.key}`}>
                {allUnits.map((u) => (
                  <option key={u.uoM_ID} value={u.description} />
                ))}
              </datalist>
            </>
          )}
        </Field>

        <Field label="Description" wide>
          <input
            value={item.productDescription}
            onChange={(e) => onChange({ productDescription: e.target.value })}
          />
        </Field>

        <Field label="Quantity" span={2}>
          <input
            className={fieldErrors.has("quantity") ? "invalid" : undefined}
            inputMode="decimal"
            value={item.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </Field>

        {/*
          * Value and unit price are interchangeable: type in either and that one becomes
          * authoritative while the other shows as derived. The derived figure is display only, so
          * a value that does not divide evenly by quantity is still filed exactly as typed.
          */}
        <Field
          label="Value excl. sales tax"
          span={3}
          hint={item.amountBasis === "unitPrice" ? "Quantity x unit price, less discount." : undefined}
        >
          <input
            className={[
              fieldErrors.has("valueSalesExcludingST") ? "invalid" : "",
              item.amountBasis === "unitPrice" ? "derived" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            inputMode="decimal"
            value={item.amountBasis === "value" ? item.value : computed.base.valueSalesExcludingST.toFixed(2)}
            onChange={(e) => onChange({ value: e.target.value, amountBasis: "value" })}
          />
        </Field>

        <Field
          label="Unit price (excl. tax)"
          span={3}
          hint={item.amountBasis === "value" ? "Worked back from the value; not sent to FBR." : undefined}
        >
          <input
            className={item.amountBasis === "value" ? "derived" : undefined}
            inputMode="decimal"
            value={item.amountBasis === "unitPrice" ? item.unitPrice : computed.base.unitPrice.toFixed(2)}
            onChange={(e) => onChange({ unitPrice: e.target.value, amountBasis: "unitPrice" })}
          />
        </Field>

        <Field label="Discount" span={2}>
          <input inputMode="decimal" value={item.discount} onChange={(e) => onChange({ discount: e.target.value })} />
        </Field>

        {isThirdSchedule && (
          <Field label="Retail price per unit" span={2} hint="3rd Schedule goods are taxed on retail price.">
            <input
              className={fieldErrors.has("fixedNotifiedValueOrRetailPrice") ? "invalid" : undefined}
              inputMode="decimal"
              value={item.retailPrice}
              onChange={(e) => onChange({ retailPrice: e.target.value })}
            />
          </Field>
        )}
      </div>

      <div className="grid item-amounts">
        <Amount
          label="Sales tax"
          field="salesTaxApplicable"
          item={item}
          computed={computed}
          onOverride={override}
          invalid={fieldErrors.has("salesTaxApplicable")}
        />
        <Amount
          label="Further tax"
          field="furtherTax"
          item={item}
          computed={computed}
          onOverride={override}
          invalid={fieldErrors.has("furtherTax")}
        />
        <Amount
          label="Extra tax"
          field="extraTax"
          item={item}
          computed={computed}
          onOverride={override}
          invalid={fieldErrors.has("extraTax")}
        />
        <Amount
          label="Sales tax withheld"
          field="salesTaxWithheldAtSource"
          item={item}
          computed={computed}
          onOverride={override}
          invalid={fieldErrors.has("salesTaxWithheldAtSource")}
        />
        <Amount
          label="FED payable"
          field="fedPayable"
          item={item}
          computed={computed}
          onOverride={override}
          invalid={fieldErrors.has("fedPayable")}
        />
      </div>
      </div>
    </div>
  );
}

/**
 * A computed amount the user can take over.
 *
 * Overridden fields are visibly marked and offer a way back to the calculated value, because the
 * calculation is right for ordinary sales and wrong for several specific ones — the user needs to
 * see at a glance which numbers are theirs.
 */
function Amount({
  label,
  field,
  item,
  computed,
  onOverride,
  invalid,
}: {
  label: string;
  field: Overridable;
  item: ItemDraft;
  computed: { applied: ReturnType<typeof computeLine> };
  onOverride: (field: Overridable, value: string) => void;
  invalid: boolean;
}) {
  const overridden = item.overrides[field] !== undefined && item.overrides[field] !== "";

  // Goes through Field so the label is actually associated with the input, like every other field.
  return (
    <Field label={overridden ? `${label} · edited` : label} span={2}>
      <input
        className={[invalid ? "invalid" : "", overridden ? "overridden" : ""].filter(Boolean).join(" ")}
        inputMode="decimal"
        value={overridden ? item.overrides[field]! : computed.applied[field].toFixed(2)}
        onChange={(e) => onOverride(field, e.target.value)}
      />
      {overridden && (
        <button className="link" style={{ alignSelf: "flex-start" }} onClick={() => onOverride(field, "")}>
          use calculated value
        </button>
      )}
    </Field>
  );
}

function CheckPanel({ result }: { result: CheckResult }) {
  if (result.status === "valid") {
    return (
      <div className="note ok">
        <strong>FBR accepted this invoice — but it has NOT been filed</strong>
        <span>
          The check passed, so filing it should succeed. Press the submit button when you're ready.
        </span>
      </div>
    );
  }

  if (result.status === "rejected") {
    return (
      <div className="note error">
        <strong>FBR would reject this invoice — nothing was filed</strong>
        <ul>
          {result.errors.map((error, i) => (
            <li key={i}>
              {error.itemSNo && <>Item {error.itemSNo}: </>}
              {error.plain}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="note error">
      <strong>Couldn't check this invoice</strong>
      <span>{result.message}</span>
    </div>
  );
}

function ResultPanel({ result }: { result: SubmitResult }) {
  if (result.status === "success") {
    return (
      <div className="note ok">
        <strong>Filed with FBR</strong>
        <span className="irn">{result.irn}</span>
        <span>This is FBR's invoice number. It must appear on the printed invoice.</span>
        {result.dated && <span className="hint">FBR recorded it at {result.dated}.</span>}
      </div>
    );
  }

  if (result.status === "rejected") {
    return (
      <div className="note error">
        <strong>
          {result.stage === "precheck"
            ? "FBR's pre-check rejected this invoice — nothing was filed"
            : "FBR rejected this invoice — nothing was filed"}
        </strong>
        <ul>
          {result.errors.map((error, i) => (
            <li key={i}>
              {error.itemSNo && <>Item {error.itemSNo}: </>}
              {error.plain}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (result.status === "uncertain") {
    return (
      <div className="note warn">
        <strong>Don't re-submit yet — we can't tell whether this was filed</strong>
        <span>{result.reason}</span>
        <span>
          FBR gives no way to check this automatically. Search for it in the IRIS portal using the
          details below, then record the outcome under "Needs checking".
        </span>
        <ul>
          {Object.entries(result.portalSearch).map(([key, value]) => (
            <li key={key}>
              {key}: <span className="mono">{String(value)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="note error">
      <strong>Couldn't submit</strong>
      <span>{result.message}</span>
    </div>
  );
}
