/**
 * Entry point. Starts the local server, opens the browser, and serves the UI.
 *
 * Launch behaviour is shaped by how this gets packaged: a single Windows .exe with the console
 * hidden has no window to close and no terminal to show an error in. So:
 *
 *   - A second double-click must not fail with EADDRINUSE and vanish. If the port is already bound
 *     we just open the browser at the running instance and exit quietly.
 *   - There has to be a way out, hence the Quit button and its endpoint. Closing the browser tab
 *     would otherwise leave an orphaned process holding the port.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import index from "../ui/index.html";

import { FbrClient } from "./fbr-client.ts";
import { loadFormReference, loadRates, loadUomForHsCode } from "./reference.ts";
import {
  completedScenarios,
  foldSubmissions,
  needsAttention,
  portalSearchHints,
  recordResolution,
} from "./log.ts";
import {
  SESSION_HEADER,
  SESSION_SECRET,
  LOOPBACK_HOST,
  forbidden,
  hasSessionSecret,
  isLocalRequest,
} from "./security.ts";
import { deleteAccount, findAccount, loadAccounts, redactAccount, tokenFor, upsertAccount } from "./store.ts";
import { precheckInvoice, submitInvoice } from "./submit.ts";
import { loadTemplate, resetTemplate, saveTemplate } from "./templates.ts";
import { dataDir, ensureDataDir } from "./paths.ts";
import { SCENARIOS, expectedBuyerRegistrationType } from "../core/scenarios.ts";
import { pakistanDate } from "../core/payload.ts";
import type { Account, Env } from "../core/types.ts";

const PORT = Number(process.env.PORT ?? 7345);
const MOCK = process.env.FBR_MOCK === "1";
const DEV = process.env.FBR_DEV === "1";

const client = new FbrClient({ mock: MOCK });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (request: Request & { params?: Record<string, string> }) => Response | Promise<Response>;

/** Wraps an /api handler with the loopback and per-launch-secret checks. */
function guard(handler: Handler): Handler {
  return async (request) => {
    if (!isLocalRequest(request, PORT)) {
      return forbidden("This endpoint only accepts requests from the app running on this machine.");
    }
    if (!hasSessionSecret(request)) {
      return forbidden("Missing or invalid session key. Reload the app.");
    }
    try {
      return await handler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  };
}

function parseEnv(value: string | null): Env {
  return value === "production" ? "production" : "sandbox";
}

/** Resolves the account and its token for this environment, or an explanatory error response. */
function withToken(
  accountId: string | null,
  env: Env,
): { ok: true; account: Account; token: string } | { ok: false; response: Response } {
  const account = accountId ? findAccount(loadAccounts(), accountId) : undefined;
  if (!account) {
    return { ok: false, response: Response.json({ error: "Unknown account." }, { status: 400 }) };
  }

  const credentials = tokenFor(account, env);
  if (!credentials.ok) {
    return { ok: false, response: Response.json({ error: credentials.reason }, { status: 400 }) };
  }

  return { ok: true, account, token: credentials.token };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function start() {
  return Bun.serve({
    hostname: LOOPBACK_HOST,
    port: PORT,
    development: DEV,
    idleTimeout: 60,

    routes: {
      "/": index,

      /*
       * Hands the page its session key.
       *
       * Safe to serve without the key it provides: no CORS headers are sent anywhere in this
       * server, so the same-origin policy prevents another site's JavaScript from reading this
       * response even though it can issue the request.
       */
      "/api/session": (request) => {
        if (!isLocalRequest(request, PORT)) {
          return forbidden("This endpoint only accepts requests from the app running on this machine.");
        }
        return Response.json({
          secret: SESSION_SECRET,
          header: SESSION_HEADER,
          mock: MOCK,
          today: pakistanDate(),
          dataDir: dataDir(),
        });
      },

      "/api/accounts": {
        GET: guard(() => Response.json({ accounts: loadAccounts().map(redactAccount) })),

        POST: guard(async (request) => {
          const body = (await request.json()) as Partial<Account>;
          if (!body.label?.trim() || !body.sellerNTNCNIC?.trim()) {
            return Response.json(
              { error: "A name and the seller's NTN/CNIC are both required." },
              { status: 400 },
            );
          }

          const existing = body.id ? findAccount(loadAccounts(), body.id) : undefined;
          const account = upsertAccount({
            ...(body.id ? { id: body.id } : {}),
            label: body.label.trim(),
            sellerNTNCNIC: body.sellerNTNCNIC.trim(),
            sellerBusinessName: body.sellerBusinessName?.trim() ?? "",
            sellerProvince: body.sellerProvince?.trim() ?? "",
            sellerAddress: body.sellerAddress?.trim() ?? "",
            // A blank token field means "leave it alone", so editing an account doesn't silently
            // wipe a token the UI never displays back.
            sandboxToken: body.sandboxToken?.trim() || existing?.sandboxToken || "",
            productionToken: body.productionToken?.trim() || existing?.productionToken || "",
            eligibleScenarios: body.eligibleScenarios ?? existing?.eligibleScenarios ?? [],
          });

          return Response.json({ account: redactAccount(account) });
        }),
      },

      "/api/accounts/:id": {
        DELETE: guard((request) => {
          deleteAccount(request.params!.id!);
          return Response.json({ ok: true });
        }),
      },

      "/api/reference": {
        GET: guard(async (request) => {
          const url = new URL(request.url);
          const env = parseEnv(url.searchParams.get("env"));
          const resolved = withToken(url.searchParams.get("accountId"), env);
          if (!resolved.ok) return resolved.response;

          const result = await loadFormReference(client, resolved.token);
          return result.ok
            ? Response.json(result.data)
            : Response.json({ error: result.reason }, { status: 502 });
        }),
      },

      "/api/rates": {
        GET: guard(async (request) => {
          const url = new URL(request.url);
          const env = parseEnv(url.searchParams.get("env"));
          const resolved = withToken(url.searchParams.get("accountId"), env);
          if (!resolved.ok) return resolved.response;

          const transTypeId = Number(url.searchParams.get("transTypeId"));
          if (!Number.isFinite(transTypeId)) {
            return Response.json({ error: "Pick a sale type first." }, { status: 400 });
          }

          const dateParam = url.searchParams.get("date");
          const date = dateParam ? new Date(dateParam) : new Date();

          const result = await loadRates(client, resolved.token, {
            date: Number.isNaN(date.getTime()) ? new Date() : date,
            transTypeId,
            originationSupplier: Number(url.searchParams.get("originationSupplier") ?? 1),
          });

          return result.ok
            ? Response.json({ rates: result.data })
            : Response.json({ error: result.reason }, { status: 502 });
        }),
      },

      "/api/uom-for-hs": {
        GET: guard(async (request) => {
          const url = new URL(request.url);
          const env = parseEnv(url.searchParams.get("env"));
          const resolved = withToken(url.searchParams.get("accountId"), env);
          if (!resolved.ok) return resolved.response;

          const hsCode = url.searchParams.get("hsCode")?.trim();
          if (!hsCode) return Response.json({ error: "Pick an HS code first." }, { status: 400 });

          const result = await loadUomForHsCode(client, resolved.token, hsCode);
          return result.ok
            ? Response.json({ unitsOfMeasure: result.data })
            : Response.json({ error: result.reason }, { status: 502 });
        }),
      },

      "/api/buyer-lookup": {
        POST: guard(async (request) => {
          const body = (await request.json()) as { accountId?: string; env?: string; registrationNo?: string };
          const env = parseEnv(body.env ?? null);
          const resolved = withToken(body.accountId ?? null, env);
          if (!resolved.ok) return resolved.response;

          const registrationNo = body.registrationNo?.trim();
          if (!registrationNo) {
            return Response.json({ error: "Enter the buyer's NTN or CNIC first." }, { status: 400 });
          }

          const result = await client.getBuyerRegistrationType(resolved.token, registrationNo);
          if (!result.ok) return Response.json({ error: result.reason }, { status: 502 });

          // FBR returns "Registered" capitalised and "unregistered" lower case, so normalise.
          const raw = (result.data.REGISTRATION_TYPE ?? "").trim().toLowerCase();
          const registrationType = raw === "registered" ? "Registered" : "Unregistered";

          return Response.json({ registrationType, raw: result.data });
        }),
      },

      /*
       * Checks an invoice against FBR without filing it.
       *
       * Hits validateinvoicedata, which records nothing, so this is safe to repeat and can never
       * leave an invoice in an unknown state.
       */
      "/api/invoice/validate": {
        POST: guard(async (request) => {
          const body = (await request.json()) as { accountId?: string } & Record<string, unknown>;
          const account = body.accountId ? findAccount(loadAccounts(), body.accountId) : undefined;
          if (!account) return Response.json({ error: "Unknown account." }, { status: 400 });

          return Response.json(await precheckInvoice(client, account, body as never));
        }),
      },

      "/api/invoice/submit": {
        POST: guard(async (request) => {
          const body = (await request.json()) as { accountId?: string } & Record<string, unknown>;
          const account = body.accountId ? findAccount(loadAccounts(), body.accountId) : undefined;
          if (!account) return Response.json({ error: "Unknown account." }, { status: 400 });

          const result = await submitInvoice(client, account, body as never);
          return Response.json(result);
        }),
      },

      "/api/submissions": {
        GET: guard(() => {
          const submissions = foldSubmissions();
          return Response.json({
            submissions,
            needsAttention: needsAttention(submissions).map((s) => ({
              ...s,
              portalSearch: portalSearchHints(s),
            })),
          });
        }),
      },

      "/api/submissions/:id/resolve": {
        POST: guard(async (request) => {
          const body = (await request.json()) as { irn?: string; note?: string };
          const irn = body.irn?.trim();
          if (!irn) {
            return Response.json(
              { error: "Enter the invoice number you found in the IRIS portal." },
              { status: 400 },
            );
          }
          recordResolution(request.params!.id!, irn, body.note?.trim() ?? "");
          return Response.json({ ok: true });
        }),
      },

      "/api/scenarios": {
        GET: guard((request) => {
          const url = new URL(request.url);
          const accountId = url.searchParams.get("accountId");
          const account = accountId ? findAccount(loadAccounts(), accountId) : undefined;
          if (!account) return Response.json({ error: "Unknown account." }, { status: 400 });

          const done = completedScenarios(account.id);
          const eligible = account.eligibleScenarios.length > 0 ? account.eligibleScenarios : [];

          return Response.json({
            all: SCENARIOS,
            eligible: eligible.map((id) => {
              const scenario = SCENARIOS.find((s) => s.id === id);
              return {
                id,
                description: scenario?.description ?? "Unknown scenario",
                saleType: scenario?.saleType ?? "",
                expectedBuyerRegistrationType: expectedBuyerRegistrationType(id),
                completed: done.has(id),
                // The whole point of the scenario screen: a scenario arrives ready to file.
                template: loadTemplate(id),
              };
            }),
            completedCount: eligible.filter((id) => done.has(id)).length,
          });
        }),
      },

      /*
       * Scenario templates.
       *
       * Saving is what turns the unverified built-in defaults into the user's own verified data:
       * a scenario corrected once on the first account is correct for every account after it.
       */
      "/api/scenario-templates/:id": {
        POST: guard(async (request) => {
          const body = (await request.json()) as {
            buyer?: unknown;
            item?: unknown;
            verify?: string;
          };
          if (!body.buyer || !body.item) {
            return Response.json({ error: "A template needs both buyer and item details." }, { status: 400 });
          }
          return Response.json({ template: saveTemplate(request.params!.id!, body as never) });
        }),

        DELETE: guard((request) => Response.json({ template: resetTemplate(request.params!.id!) })),
      },

      "/api/quit": {
        POST: guard(() => {
          // Respond first; the browser needs the reply before the process goes away.
          setTimeout(() => process.exit(0), 150);
          return Response.json({ ok: true });
        }),
      },
    },

    fetch() {
      return new Response("Not found", { status: 404 });
    },
  });
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];

  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // Not fatal — the URL is printed below, and on a hidden-console build the user is already
    // looking at a browser we opened on a previous run.
  }
}

async function isAlreadyRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

const url = `http://${LOOPBACK_HOST}:${PORT}`;

/**
 * Writes a startup failure somewhere the user can find it.
 *
 * The Windows build runs with the console hidden, so console.error goes nowhere and a failed launch
 * would look like double-clicking an icon and nothing happening at all.
 */
function reportStartupFailure(message: string): void {
  console.error(message);
  try {
    appendFileSync(
      join(ensureDataDir(), "startup-error.log"),
      `${new Date().toISOString()} ${message}\n`,
      "utf8",
    );
  } catch {
    // If even that fails there is nothing further to try.
  }
}

try {
  start();
  console.log(`FBR Invoicing is running at ${url}`);
  console.log(`Mode: ${MOCK ? "MOCK (no calls to FBR)" : "live"}`);
  console.log(`Data: ${dataDir()}`);
  if (!DEV) openBrowser(url);
} catch (error) {
  // Almost certainly EADDRINUSE from a second double-click. Point the user at the instance that is
  // already running rather than dying silently behind a hidden console.
  if (await isAlreadyRunning(url)) {
    console.log(`FBR Invoicing is already running. Opening ${url}`);
    openBrowser(url);
    process.exit(0);
  }

  reportStartupFailure(
    `Couldn't start on port ${PORT}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
