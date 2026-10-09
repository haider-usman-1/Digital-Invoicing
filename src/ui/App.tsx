import { useCallback, useEffect, useState } from "react";
import { api, currentSession, initSession } from "./api.ts";
import { NewInvoice } from "./NewInvoice.tsx";
import { Settings } from "./Settings.tsx";
import { Scenarios } from "./Scenarios.tsx";
import { Attention } from "./Attention.tsx";
import type { Env } from "../core/types.ts";

/** An account as the browser sees it: seller details, but never the tokens themselves. */
export interface UiAccount {
  id: string;
  label: string;
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  eligibleScenarios: string[];
  hasSandboxToken: boolean;
  hasProductionToken: boolean;
}

type Tab = "invoice" | "scenarios" | "attention" | "settings";

export function App() {
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<UiAccount[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [env, setEnv] = useState<Env>("sandbox");
  const [tab, setTab] = useState<Tab>("invoice");
  const [attentionCount, setAttentionCount] = useState(0);

  const refreshAccounts = useCallback(async () => {
    const { accounts: loaded } = await api.get<{ accounts: UiAccount[] }>("/api/accounts");
    setAccounts(loaded);
    setAccountId((current) => (current && loaded.some((a) => a.id === current) ? current : (loaded[0]?.id ?? null)));
    return loaded;
  }, []);

  const refreshAttention = useCallback(async () => {
    const { needsAttention } = await api.get<{ needsAttention: unknown[] }>("/api/submissions");
    setAttentionCount(needsAttention.length);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await initSession();
        const loaded = await refreshAccounts();
        await refreshAttention();
        // Nothing configured yet, so send the user where they have to start.
        if (loaded.length === 0) setTab("settings");
        setReady(true);
      } catch (error) {
        setStartupError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [refreshAccounts, refreshAttention]);

  if (startupError) {
    return (
      <div className="content">
        <div className="note error">
          <strong>Couldn't start</strong>
          <span>{startupError}</span>
        </div>
      </div>
    );
  }

  if (!ready) return <div className="loading">Starting…</div>;

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const session = currentSession();

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">FBR Invoicing</span>

        <nav className="tabs">
          <Tabs tab={tab} setTab={setTab} attentionCount={attentionCount} />
        </nav>

        <div className="topbar-right">
          {accounts.length > 0 && (
            <select
              aria-label="Seller account"
              value={accountId ?? ""}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          )}

          <select aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value as Env)}>
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>

          <button className="small" onClick={() => void api.post("/api/quit").then(() => window.close())}>
            Quit
          </button>
        </div>
      </div>

      <EnvBanner env={env} account={account} mock={session.mock} />

      <div className="content">
        {tab === "invoice" && (
          <NewInvoice account={account} env={env} onSubmitted={() => void refreshAttention()} />
        )}
        {tab === "scenarios" && <Scenarios account={account} env={env} />}
        {tab === "attention" && <Attention onResolved={() => void refreshAttention()} />}
        {tab === "settings" && <Settings accounts={accounts} onChanged={() => void refreshAccounts()} />}
      </div>
    </div>
  );
}

function Tabs({
  tab,
  setTab,
  attentionCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  attentionCount: number;
}) {
  const items: Array<{ id: Tab; label: string }> = [
    { id: "invoice", label: "New invoice" },
    { id: "scenarios", label: "Scenario testing" },
    { id: "attention", label: attentionCount > 0 ? `Needs checking (${attentionCount})` : "Needs checking" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <>
      {items.map((item) => (
        <button
          key={item.id}
          className="tab"
          aria-current={tab === item.id ? "page" : undefined}
          onClick={() => setTab(item.id)}
        >
          {item.label}
        </button>
      ))}
    </>
  );
}

/**
 * Always visible, and deliberately loud in production.
 *
 * A production filing cannot be undone through the API — corrections are portal-only, capped at 72
 * hours and limited to 10% of last month's sales — so the cost of a moment's confusion here is
 * high and the cost of a coloured bar is nothing.
 */
function EnvBanner({ env, account, mock }: { env: Env; account: UiAccount | null; mock: boolean }) {
  const missingToken =
    account !== null && (env === "sandbox" ? !account.hasSandboxToken : !account.hasProductionToken);

  return (
    <div className={`env-banner ${env}`}>
      <span className="env-dot" />
      <span>{env === "sandbox" ? "SANDBOX — nothing is filed for real" : "PRODUCTION — invoices are filed for real"}</span>
      <span className="spacer">
        {mock && "Mock mode: no calls leave this machine. "}
        {account ? account.label : "No account configured"}
        {missingToken && ` · no ${env} token saved`}
      </span>
    </div>
  );
}
