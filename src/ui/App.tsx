import { useCallback, useEffect, useState } from "react";
import { api, currentSession, initSession } from "./api.ts";
import { NewInvoice } from "./NewInvoice.tsx";
import { Settings } from "./Settings.tsx";
import { Scenarios } from "./Scenarios.tsx";
import { Attention } from "./Attention.tsx";
import { iconFor, loadPreference, onThemeChange, resolveTheme, savePreference } from "./theme.ts";
import type { ResolvedTheme, ThemePreference } from "./theme.ts";
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
  const [theme, setTheme] = useState<ThemePreference>(() => loadPreference());
  // Tracked separately because "system" can change under us while the app is open.
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(loadPreference()));

  useEffect(() => onThemeChange(setResolved), []);
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
        <span className="brand">
          <img src={iconFor(resolved)} width={18} height={18} alt="" />
          <span>FBR Invoicing</span>
        </span>

        <nav className="tabs">
          <Tabs tab={tab} setTab={setTab} attentionCount={attentionCount} />
        </nav>

        <div className="topbar-right">
          {accounts.length > 0 && (
            <select
              className="account"
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

          <ThemeControl
            value={theme}
            onChange={(next) => {
              savePreference(next);
              setTheme(next);
            }}
          />

          <button
            className="small"
            onClick={() => void api.post("/api/quit").then(() => window.close())}
          >
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

/**
 * Light / dark / follow-the-OS.
 *
 * Three options rather than a two-state switch: "follow the OS" is a real choice, and a toggle
 * that only flips between light and dark silently throws it away the first time it is pressed.
 */
function ThemeControl({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const options: Array<{ id: ThemePreference; label: string; icon: React.ReactNode }> = [
    { id: "system", label: "Match system theme", icon: <SystemIcon /> },
    { id: "light", label: "Light theme", icon: <SunIcon /> },
    { id: "dark", label: "Dark theme", icon: <MoonIcon /> },
  ];

  return (
    <div className="segmented" role="group" aria-label="Theme">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.label}
          aria-label={option.label}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

function SystemIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 14h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
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
  const items: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "invoice", label: "New invoice" },
    { id: "scenarios", label: "Scenario testing" },
    // The badge lives in its own element so the tab's own text stays exactly its name.
    { id: "attention", label: "Needs checking", ...(attentionCount > 0 ? { badge: attentionCount } : {}) },
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
          {item.badge !== undefined && <span className="pill unsure">{item.badge}</span>}
        </button>
      ))}
    </>
  );
}

/**
 * Always visible, and deliberately loud in production.
 *
 * A production filing cannot be undone through the API — corrections are portal-only, capped at 72
 * hours and limited to 10% of last month's sales — so the cost of a moment's confusion here is high
 * and the cost of a coloured bar is nothing.
 */
function EnvBanner({ env, account, mock }: { env: Env; account: UiAccount | null; mock: boolean }) {
  const missingToken =
    account !== null && (env === "sandbox" ? !account.hasSandboxToken : !account.hasProductionToken);

  return (
    <div className={`env-banner ${env}`}>
      <span className="env-dot" />
      <span>
        {env === "sandbox" ? "SANDBOX — nothing is filed for real" : "PRODUCTION — invoices are filed for real"}
      </span>
      <span className="spacer">
        {mock && "Mock mode: no calls leave this machine. "}
        {account ? account.label : "No account configured"}
        {missingToken && ` · no ${env} token saved`}
      </span>
    </div>
  );
}
