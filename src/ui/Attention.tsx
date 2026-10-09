import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { Field } from "./Settings.tsx";

/** The portal-search keys come from the server as field names; nobody should have to read those. */
const SEARCH_LABELS: Record<string, string> = {
  invoiceDate: "Invoice date",
  buyerName: "Buyer name",
  buyerNTNCNIC: "Buyer NTN / CNIC",
  totalExcludingTax: "Total excluding tax",
  sellerNTNCNIC: "Seller NTN / CNIC",
};

interface PendingSubmission {
  id: string;
  at: string;
  accountLabel: string;
  env: string;
  internalInvoiceNumber: string;
  status: string;
  reason: string | null;
  portalSearch: Record<string, string | number>;
}

/**
 * Submissions that ended without a clear answer.
 *
 * FBR has no idempotency key, no read API and performs no retries, so a dropped connection leaves a
 * genuine unknown: the invoice may be on file. Re-submitting risks a duplicate, and duplicates are
 * painful — corrections are portal-only, capped at 72 hours, and limited to 10% of last month's
 * sales.
 *
 * So the only honest resolution is a human checking the IRIS portal. This screen gives them the
 * exact search details and a way to record what they found, which is what keeps "uncertain" from
 * being a dead end that silently accumulates.
 */
export function Attention({ onResolved }: { onResolved: () => void }) {
  const [items, setItems] = useState<PendingSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .get<{ needsAttention: PendingSubmission[] }>("/api/submissions")
      .then((r) => setItems(r.needsAttention))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  if (error) return <div className="note error">{error}</div>;
  if (!items) return <div className="loading">Loading…</div>;

  if (items.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>Needs checking</h2>
        </div>
        <div className="empty">
          Nothing to check. Every invoice you've submitted came back with a clear answer from FBR.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="note warn">
        <strong>
          {items.length} submission{items.length === 1 ? "" : "s"} with no confirmed outcome
        </strong>
        <span>
          Each of these may or may not have been filed. Check the IRIS portal before sending the
          invoice again — a duplicate filing is much harder to undo than a missing one.
        </span>
      </div>

      {items.map((item) => (
        <PendingCard
          key={item.id}
          item={item}
          onResolved={() => {
            refresh();
            onResolved();
          }}
        />
      ))}
    </>
  );
}

function PendingCard({ item, onResolved }: { item: PendingSubmission; onResolved: () => void }) {
  const [irn, setIrn] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/submissions/${item.id}/resolve`, { irn, note });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>{item.internalInvoiceNumber || "(no invoice number)"}</h3>
        <span className={`pill ${item.status === "pending" ? "unsure" : "bad"}`}>
          {item.status === "pending" ? "stopped mid-submission" : "no answer from FBR"}
        </span>
        <span className="spacer" />
        <span className="hint">
          {item.accountLabel} · {item.env} · {new Date(item.at).toLocaleString()}
        </span>
      </div>

      <div className="card-body">
        {item.reason && <p className="hint">{item.reason}</p>}
        {item.status === "pending" && (
          <p className="hint">
            The app recorded the attempt but never recorded a reply, so it was interrupted part way
            through.
          </p>
        )}

        <div className="field">
          <label>Search for this in IRIS using</label>
          <dl className="detail-list">
            {Object.entries(item.portalSearch).map(([key, value]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{SEARCH_LABELS[key] ?? key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>

        {error && <div className="note error">{error}</div>}

        <div className="grid">
          <Field
            label="FBR invoice number, if you found it"
            span={6}
            hint="Recording it here marks this as filed and clears the warning."
          >
            <input value={irn} onChange={(e) => setIrn(e.target.value)} placeholder="0786909DI1CFGJK395794" />
          </Field>
          <Field label="Note" span={6}>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Found in IRIS, invoice was filed"
            />
          </Field>
        </div>
      </div>

      <div className="card-foot">
        <div className="actions">
          <button className="primary" onClick={() => void resolve()} disabled={saving || !irn.trim()}>
            {saving ? "Saving…" : "Mark as filed"}
          </button>
          <span className="hint">
            If IRIS has no such invoice, it wasn't filed — submit it again from the New invoice screen.
          </span>
        </div>
      </div>
    </div>
  );
}
