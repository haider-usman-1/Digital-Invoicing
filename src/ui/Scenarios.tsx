import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { NewInvoice } from "./NewInvoice.tsx";
import type { UiAccount } from "./App.tsx";
import type { Env } from "../core/types.ts";

interface EligibleScenario {
  id: string;
  description: string;
  saleType: string;
  expectedBuyerRegistrationType: string;
  completed: boolean;
}

/**
 * Progress toward a production token.
 *
 * This is the blocking task for any account that hasn't finished sandbox validation: FBR issues the
 * production token only once every eligible scenario has a successfully POSTED invoice. Each row
 * starts a prefilled invoice, because the alternative is retyping a full invoice a dozen times per
 * account on exactly the sale types that are hardest to get right.
 *
 * Only successful posts count — a passing pre-check moves nothing.
 */
export function Scenarios({ account, env }: { account: UiAccount | null; env: Env }) {
  const [scenarios, setScenarios] = useState<EligibleScenario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!account) return;
    api
      .get<{ eligible: EligibleScenario[] }>(`/api/scenarios?accountId=${account.id}`)
      .then((r) => setScenarios(r.eligible))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [account]);

  useEffect(refresh, [refresh]);

  if (!account) {
    return (
      <div className="note warn">
        <strong>No account selected</strong>
        <span>Add a seller account in Settings first.</span>
      </div>
    );
  }

  if (error) return <div className="note error">{error}</div>;
  if (!scenarios) return <div className="loading">Loading…</div>;

  const done = scenarios.filter((s) => s.completed).length;
  const allDone = scenarios.length > 0 && done === scenarios.length;

  return (
    <>
      {env === "production" && (
        <div className="note warn">
          <strong>Switch to sandbox</strong>
          <span>Scenario testing only applies to sandbox. FBR rejects a scenario on a production invoice.</span>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Scenario testing — {account.label}</h2>
          <span className="hint">
            {scenarios.length === 0
              ? "No eligible scenarios listed"
              : `${done} of ${scenarios.length} passed`}
          </span>
        </div>

        {scenarios.length === 0 ? (
          <div className="empty">
            Open Settings and tick the scenarios IRIS lists for this registration, under
            Digital Invoicing → Eligible Scenarios.
          </div>
        ) : (
          <>
            <div className="progress">
              <div style={{ width: `${(done / scenarios.length) * 100}%` }} />
            </div>

            {allDone ? (
              <div className="note ok">
                <strong>All eligible scenarios passed</strong>
                <span>
                  FBR generates the production token automatically. Collect it from IRIS →
                  Production Environment → View Security Token, then paste it into Settings.
                </span>
              </div>
            ) : (
              <p className="hint">
                Each scenario needs one successfully filed sandbox invoice. The sale type is fixed by
                FBR, so starting from a scenario fills it in for you.
              </p>
            )}

            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Sale type</th>
                  <th>Buyer</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {scenarios.map((scenario) => (
                  <tr key={scenario.id}>
                    <td>
                      <strong>{scenario.id}</strong>
                      <br />
                      <span className="hint">{scenario.description}</span>
                    </td>
                    <td>{scenario.saleType}</td>
                    <td>{scenario.expectedBuyerRegistrationType}</td>
                    <td>
                      <span className={`pill ${scenario.completed ? "done" : "todo"}`}>
                        {scenario.completed ? "passed" : "not yet"}
                      </span>
                    </td>
                    <td>
                      <button className="small" onClick={() => setActive(scenario.id)}>
                        {scenario.completed ? "Run again" : "Start"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {active && (
        <>
          <div className="card-head">
            <h2>Scenario {active}</h2>
            <button className="link" onClick={() => setActive(null)}>
              close
            </button>
          </div>
          {/* Remount on scenario change so the form prefills cleanly rather than merging state. */}
          <NewInvoice
            key={active}
            account={account}
            env={env}
            initialScenarioId={active}
            onSubmitted={refresh}
          />
        </>
      )}
    </>
  );
}
