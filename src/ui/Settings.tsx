import { Children, cloneElement, isValidElement, useId, useState } from "react";
import { api, currentSession } from "./api.ts";
import { SCENARIOS } from "../core/scenarios.ts";
import type { UiAccount } from "./App.tsx";

/**
 * Account configuration.
 *
 * The seller block lives here and nowhere else. FBR binds each token to one seller NTN and rejects
 * a mismatch with error 0401, so letting the invoice form edit these fields would make the single
 * likeliest mistake possible: account A's token paired with account B's details.
 */
export function Settings({ accounts, onChanged }: { accounts: UiAccount[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<UiAccount | "new" | null>(accounts.length === 0 ? "new" : null);

  return (
    <>
      {accounts.length === 0 && editing !== "new" && (
        <div className="note warn">
          <strong>No accounts yet</strong>
          <span>Add a seller account to start filing invoices.</span>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Seller accounts</h2>
          <span className="hint">Stored on this machine at {currentSession().dataDir}</span>
        </div>

        {accounts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Seller NTN / CNIC</th>
                <th>Tokens</th>
                <th>Scenarios</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.label}</td>
                  <td className="mono">{account.sellerNTNCNIC}</td>
                  <td>
                    <span className={`pill ${account.hasSandboxToken ? "done" : "todo"}`}>sandbox</span>{" "}
                    <span className={`pill ${account.hasProductionToken ? "done" : "todo"}`}>production</span>
                  </td>
                  <td>{account.eligibleScenarios.length || "—"}</td>
                  <td>
                    <div className="actions">
                      <button className="small" onClick={() => setEditing(account)}>
                        Edit
                      </button>
                      <button
                        className="small danger"
                        onClick={() => {
                          void api.delete(`/api/accounts/${account.id}`).then(onChanged);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="actions">
          <button className="primary" onClick={() => setEditing("new")}>
            Add an account
          </button>
        </div>
      </div>

      {editing !== null && (
        <AccountForm
          account={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function AccountForm({
  account,
  onCancel,
  onSaved,
}: {
  account: UiAccount | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    label: account?.label ?? "",
    sellerNTNCNIC: account?.sellerNTNCNIC ?? "",
    sellerBusinessName: account?.sellerBusinessName ?? "",
    sellerProvince: account?.sellerProvince ?? "",
    sellerAddress: account?.sellerAddress ?? "",
    sandboxToken: "",
    productionToken: "",
  });
  const [eligible, setEligible] = useState<string[]>(account?.eligibleScenarios ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/accounts", {
        ...(account ? { id: account.id } : {}),
        ...form,
        eligibleScenarios: eligible,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>{account ? `Edit ${account.label}` : "New account"}</h2>
      </div>

      {error && <div className="note error">{error}</div>}

      <div className="grid">
        <Field label="Name for this account" hint="Only shown in this app.">
          <input value={form.label} onChange={(e) => set("label")(e.target.value)} placeholder="Acme Traders" />
        </Field>
        <Field label="Seller NTN / CNIC" hint="7 digits for an NTN, 13 for a CNIC. No dashes.">
          <input
            value={form.sellerNTNCNIC}
            onChange={(e) => set("sellerNTNCNIC")(e.target.value)}
            inputMode="numeric"
            placeholder="0786909"
          />
        </Field>
        <Field label="Registered business name">
          <input
            value={form.sellerBusinessName}
            onChange={(e) => set("sellerBusinessName")(e.target.value)}
          />
        </Field>
        <Field label="Province" hint="Must match FBR's spelling exactly.">
          <input value={form.sellerProvince} onChange={(e) => set("sellerProvince")(e.target.value)} placeholder="Sindh" />
        </Field>
        <Field label="Address">
          <input value={form.sellerAddress} onChange={(e) => set("sellerAddress")(e.target.value)} />
        </Field>
      </div>

      <div className="grid">
        <Field
          label="Sandbox token"
          hint="IRIS → Digital Invoicing → Sandbox Environment → View Web API Environment Details."
        >
          <input
            type="password"
            value={form.sandboxToken}
            onChange={(e) => set("sandboxToken")(e.target.value)}
            placeholder={account?.hasSandboxToken ? "Saved — leave blank to keep it" : ""}
            autoComplete="off"
          />
        </Field>
        <Field
          label="Production token"
          hint="FBR generates this automatically once every eligible scenario has passed in sandbox."
        >
          <input
            type="password"
            value={form.productionToken}
            onChange={(e) => set("productionToken")(e.target.value)}
            placeholder={account?.hasProductionToken ? "Saved — leave blank to keep it" : ""}
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="field">
        <label>Eligible scenarios</label>
        {/*
         * Taken from the user's own IRIS dashboard rather than derived here. FBR publishes a
         * Business-Nature x Sector matrix, but it contains duplicate and missing rows, and the
         * dashboard's "Eligible Scenarios" tile is the authoritative live list per registration.
         */}
        <p className="field-note">
          Tick the ones IRIS lists for this registration, under Digital Invoicing → Eligible Scenarios.
          Each one needs a successfully posted sandbox invoice before FBR issues the production token.
        </p>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))" }}>
          {SCENARIOS.map((scenario) => (
            <label key={scenario.id} style={{ display: "flex", gap: "0.45rem", fontSize: "0.85rem" }}>
              <input
                type="checkbox"
                style={{ width: "auto", minWidth: 0 }}
                checked={eligible.includes(scenario.id)}
                onChange={(e) =>
                  setEligible((list) =>
                    e.target.checked ? [...list, scenario.id] : list.filter((id) => id !== scenario.id),
                  )
                }
              />
              <span>
                <strong>{scenario.id}</strong> — {scenario.description}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="actions">
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save account"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Associates the label with the field's first control.
 *
 * Without this the label is just text sitting next to an input: clicking it does nothing and a
 * screen reader never announces which input it belongs to. Targeting the first control is right for
 * every field here — a trailing button (like "Check") or a `<datalist>` is never the thing being
 * labelled.
 */
const LABELLABLE = new Set(["input", "select", "textarea"]);

function withControlId(children: React.ReactNode, id: string): React.ReactNode {
  // Descends through layout wrappers rather than taking the first child blindly: some fields wrap
  // their input in a div to sit a button beside it, and a <div> cannot be labelled. Buttons are
  // skipped too — a trailing "Check" is not the thing the label names.
  const done = { value: false };

  function visit(node: React.ReactNode): React.ReactNode {
    if (done.value || !isValidElement(node)) return node;

    if (typeof node.type === "string" && LABELLABLE.has(node.type)) {
      done.value = true;
      return cloneElement(node as React.ReactElement<{ id?: string }>, { id });
    }

    const nested = (node.props as { children?: React.ReactNode }).children;
    if (nested === undefined) return node;

    return cloneElement(node as React.ReactElement<{ children?: React.ReactNode }>, {
      children: Children.toArray(nested).map(visit),
    });
  }

  return Children.toArray(children).map(visit);
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {withControlId(children, id)}
      {hint && <span className="field-note">{hint}</span>}
    </div>
  );
}
