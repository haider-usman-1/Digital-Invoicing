# FBR Digital Invoicing — Local Windows App

## Context

The user files sales invoices to Pakistan's FBR **Digital Invoicing (DI)** system for several seller
registrations. Today that means the IRIS portal's manual entry or hand-rolled API calls. They want a
small local tool with a GUI a non-technical person can drive: pick a seller account, enter buyer
details, sale type, scenario, HS codes and pricing, and get back FBR's invoice reference number
(IRN) — or a plain-language explanation of what FBR rejected.

A second, more urgent need surfaced during questioning: **some of their accounts have not yet passed
sandbox scenario validation**, so those accounts have no production token at all. FBR only issues a
production token after the account successfully posts one invoice per *eligible scenario* (11+ for a
typical registration). This app is therefore also the tool that unblocks those tokens, which is why
prefilled scenario templates are in v1 rather than on the roadmap.

**Constraints agreed with the user**

- Runs locally on a **Windows** machine; development happens on **macOS**.
- **Bare minimum first**, with a living roadmap document tracking what comes later.
- Several seller accounts, each with its own seller details and tokens, all configurable in-app.
- **Both sandbox and production**, with an unmissable indicator of which is active.
- Few accounts, a few invoices a day, 1–5 line items — optimise for one clean screen.
- Document types: **Sale Invoice only**. Internal invoice reference typed by the user.
- Tokens in a plain local config file (no master password, no login step).
- Tax amounts auto-computed but **editable with an override marker**.

**Explicitly out of v1:** debit/credit notes, printable invoice/PDF with QR code, buyer and item
catalogs, browsable invoice history UI, CSV/bulk import. All go on the roadmap.

## Research basis

Everything below rests on PRAL's *Technical Specification for DI API* **v1.12** (24-Jul-2025, still
the current version) and the *Digital Invoicing User Manual* **v1.6** (16-Apr-2026), extracted
verbatim rather than recalled. These findings each change the implementation:

| Finding | Consequence for the build |
|---|---|
| Separate `_sb` endpoint paths for sandbox **and** separate tokens per environment | Account holds two tokens; `env` is an explicit parameter on every call |
| `scenarioId` is **sandbox-only**, absent from production samples | Field is *deleted* from the payload in production, not blanked |
| **Success trap:** item-level failures return outer `statusCode: "00"` with outer `status: "invalid"` (lowercase) | Success iff `invoiceNumber` non-empty **and** every `invoiceStatuses[].statusCode === "00"`; compare status case-insensitively |
| Business validation failures arrive as **HTTP 200** | HTTP status is not the success signal |
| **No idempotency key; FBR performs no automatic retries** | A dropped connection is genuinely ambiguous — needs an explicit `UNCERTAIN` state, never a blind retry |
| `rate` is a **string** (`ratE_DESC`, e.g. `"18%"`); `uoM` and `saleType` are also description strings | All three must come from reference endpoints; free text would be guesswork |
| `SaleTypeToRate` takes a **`date` parameter** — rates change by SRO | Reference cache must be keyed on `(date, transTypeId, originationSupplier)` or it serves silently stale rates |
| Reference endpoints split across `/pdi/v1/` and `/pdi/v2/`, mixed-case paths, inconsistent param naming | Endpoint table is written out literally; paths are case-sensitive |
| Errors `0401`/`0402`: the token is **bound to the seller NTN** | Account must atomically own seller fields *and* both tokens |
| Error `0300`: nominally optional numeric fields are rejected if malformed | Always send `0.00`, never `null`, `""`, or omitted |
| `buyerNTNCNIC` is a **string** (the spec's own field table wrongly shows it unquoted) | Deliberate payload builder, not `JSON.stringify` of a loose object |
| Provinces come back `"SINDH"` but samples send `"Sindh"` | Store and resend the exact reference string; never retype |
| 28 scenario IDs; eligibility depends on Business Nature × Sector, and the **IRIS dashboard is authoritative** (the spec's own matrix has duplicate and missing rows) | Eligible list is per-account and user-editable; do not hard-code the matrix |
| `/dist/v1/Get_Reg_Type` resolves a buyer's registration type | Cheap "check buyer" button; prevents errors `0012`/`0053` |
| Corrections are **portal-only** (no cancel API), capped at 72 hours | App never promises to amend; it links the user to IRIS |

**Known-unknown list** — to be probed against sandbox, never guessed: whether `totalValues: 0.00` is
accepted for ordinary sales (samples say yes, prose implies otherwise); FBR's rounding mode; whether
discount precedes tax; the HTTP verb for `Get_Reg_Type`/`statl`; province case-sensitivity. Each gets
a named assumption in code and a line in the roadmap doc.

## Architecture

One TypeScript codebase. **Bun** is runtime, bundler and packager; `bun build --compile
--target=bun-windows-x64` produces a single Windows `.exe` from macOS. Double-clicking it starts a
localhost server, opens the default browser, and serves the UI. React + Tailwind for the front end,
using **Bun's native HTML entrypoint** — no Vite, because `--compile` with an HTML import already
bundles and embeds React/CSS/assets, and two bundlers for a three-screen form is waste.

The backend owns every FBR call; a token never reaches the browser.

### Modules

Each is independently testable, and the three that encode FBR's sharp edges are pure functions with
no I/O:

- **`calc.ts`** — pure. Given quantity, unit price, discount and the chosen `SaleTypeToRate` row,
  returns the money fields *plus* an explicit `assumptions`/`confidence` list. Critically, it
  **declares when it cannot compute**: compound rates like `"18% along with rupees 60 per kilogram"`
  carry a per-unit component that exists only in prose, and 3rd Schedule goods are assessed on
  `fixedNotifiedValueOrRetailPrice` rather than sale value. In those cases it returns the percentage
  part, flags low confidence, and the UI tells the user plainly that they must supply the rest.
  `furtherTax`/`extraTax` are explicit inputs, never inferred. Half-up at 2dp. Heavily unit-tested.
- **`outcome.ts`** — pure. The single place that maps an FBR response to
  `Success(irn) | Rejected(errors[]) | Uncertain`, implementing the success-trap rule above, and
  translating error codes into plain language via a code→message table.
- **`payload.ts`** — pure. Builds the wire JSON explicitly, field by field: correct casing (`uoM`,
  `buyerRegistrationType`), strings as strings, `0.00` for unused numerics, `scenarioId` present only
  in sandbox, `invoiceDate` formatted in **`Asia/Karachi`** (a UTC-derived date can file on the wrong
  day, and corrections only reach 3 days back).
- **`fbr-client.ts`** — thin typed wrapper over the 4 invoice endpoints and the 6 reference endpoints
  v1 needs. Takes `(token, env)` explicitly. Has a **mock mode** returning canned valid / invalid /
  uncertain responses, so the entire UI is buildable and testable with no network and no real token —
  this is what lets implementation proceed ahead of the sandbox probes.
- **`store.ts`** — accounts and reference cache. The **account is the atomic owner** of
  `{sellerNTNCNIC, sellerBusinessName, sellerProvince, sellerAddress, sandboxToken, productionToken,
  eligibleScenarios}`. The invoice form can never edit seller fields independently, and the token is
  derived from `(account, env)` in exactly one function. This closes the most likely real-world
  mistake: pairing account A's token with account B's seller block across a 4-way account×env matrix.
- **`log.ts`** — an **event log**, not a mutable record: appends `SUBMIT_ATTEMPTED` (with the full
  payload as sent, flushed to disk *before* the network call) then `SUBMIT_RESULT`, folding events at
  read time.

### Storage

Plain JSON under `%APPDATA%\fbr-di\` — `accounts.json`, `reference-cache.json`,
`submissions.ndjson`. No SQLite, deliberately: a native module would compromise the clean single-exe
cross-compile. `%APPDATA%` rather than beside the exe because the user profile has user-scoped ACLs
by default, which an exe sitting in `Downloads` or a shared folder may not — free hardening given the
user declined a login step.

### Local server security

The localhost API can file real tax invoices, so it is treated as a privileged surface. Any website
open in the same browser could otherwise `fetch` it:

- Bind explicitly to `127.0.0.1`, never `0.0.0.0`.
- Generate a random per-launch secret, inject it into the served HTML, require it as a header on
  every `/api/*` call.
- Validate `Origin`/`Host` against the exact expected `127.0.0.1:PORT`.
- Never write tokens to the log; redact `Authorization` from all debug output.

### Submission flow

One user action, two calls: build payload → `validateinvoicedata` → if valid,
`postinvoicedata` → record result. Validation is not exposed as a separate button (a layman would
skip it) and validate-success is not treated as a guarantee — rejection is still handled on post. At
a few invoices a day the extra call is free, and the payoff is never creating an ambiguous POST for a
payload that was going to be rejected anyway.

**`UNCERTAIN` has an exit.** Because there is no read API, reconciliation means a human searching the
IRIS portal — so the app shows the exact search parameters (date, buyer, amount) and lets the user
paste the IRN they found to close the entry out. Without that, uncertain entries accumulate forever
and the state is a dead end.

### Screens

1. **New Invoice** — single page. Account selector; buyer block with a "check buyer" button
   (`Get_Reg_Type`) that auto-fills registration type; sale type, scenario (sandbox only) and HS code
   as type-to-search pickers backed by the synced reference lists, with UoM constrained by the chosen
   HS code; line items with computed-but-editable amounts, overrides visibly marked. Result panel
   shows the IRN prominently, or rejections mapped to the offending field in plain language.
2. **Settings** — account CRUD: seller details, both tokens, eligible scenario list.
3. **Scenario validation** (sandbox only) — per-account checklist of eligible scenarios, each a
   one-click **prefilled** invoice (sale type fixed per FBR's spec table, plus a starting HS code and
   UoM) that the user adjusts and submits. Only successful **posts** count toward completion, not
   validate calls.

A persistent banner shows **SANDBOX** (amber) or **PRODUCTION** (red) for the active account.

### Packaging

The Windows single-exe path has rough edges worth planning for rather than discovering:

- `--windows-hide-console` is the one Windows flag that survives cross-compilation, but it has a
  history of silently not applying (Bun issues #19916, #24164). Verify on the pinned Bun version;
  a visible console must remain an acceptable fallback, not a broken state.
- With no console there is **no way to quit** and nothing to close. Needs an explicit **Quit** button
  in the UI that shuts the server down.
- A second double-click would hit `EADDRINUSE` and fail silently. Needs single-instance detection: if
  the port is already bound, open the browser at it and exit cleanly.
- **Icon and version metadata are not possible when cross-compiling from macOS** — they need a
  Windows build host. Accepted for now; a Windows CI runner is on the roadmap.
- An unsigned ~100 MB binary triggers SmartScreen's "Windows protected your PC" on first run. This is
  a hard first-run blocker for a non-technical user, so the setup doc must walk through
  *More info → Run anyway*. Code signing goes on the roadmap.
- Skip `--bytecode` and `--minify` — unnecessary variables in a step that already has surprises.

## Build order

Implementation is test-driven: the pure modules (`calc`, `outcome`, `payload`) get tests written
first, since they encode exactly the FBR rules that are expensive to get wrong and cheap to verify.

1. Repo scaffold, `git init`, Bun + React + Tailwind, pinned Bun version. Commit this plan as the
   design doc at `docs/superpowers/specs/2026-10-09-fbr-digital-invoicing-design.md`, and create
   `docs/ROADMAP.md` (the living document the user asked for) and `docs/SETUP-WINDOWS.md`.
2. `payload.ts`, `outcome.ts`, `calc.ts` with tests, including the success-trap and
   low-confidence-rate cases.
3. `fbr-client.ts` with mock mode; `store.ts`; `log.ts` with the event-fold and flush-before-send.
4. Server routes with the localhost hardening.
5. UI: Settings, then New Invoice, then Scenario validation.
6. Sandbox probes for the known-unknown list; record answers in the roadmap doc.
7. Windows cross-compile, then the single-instance and Quit behaviours.

## Verification

- `bun test` for the pure modules — the calculation and response-interpretation rules, including
  deliberately malformed FBR responses that exercise the success trap.
- Run the app locally on macOS in mock mode and drive the real UI end to end (browser automation) to
  confirm each screen, the environment banner, override markers, and the rejection display.
- Against **sandbox** with a real token: post a standard-rate invoice and confirm a well-formed IRN
  comes back; confirm a deliberately bad HS code surfaces the right plain-language error; walk one
  account's scenario checklist and confirm completions are tracked.
- Verify `UNCERTAIN` by pointing the client at an unreachable host mid-submit, then confirm the entry
  appears with its payload and can be closed out by pasting an IRN.
- Cross-compile the exe and have the user run it on the Windows machine: first-run SmartScreen path,
  browser opens, second double-click does not fail, Quit works.
- **Production is not exercised until the user explicitly asks** — a real filing is not reversible by
  API.

## Roadmap (tracked in `docs/ROADMAP.md`)

Debit/credit notes (needs the undocumented `reason`/`reasonRemarks` keys probed first) · printable
invoice and PDF with QR code (encode the IRN; PRAL specifies QR v2 at 1 inch, which conflicts with
SRO 69(I)/2025's 7 mm — resolve before shipping) · buyer and item catalogs · browsable invoice
history with filtering · the SRO field family (`sroScheduleNo`, `sroItemSerialNo`) and its four
reference endpoints · CSV/bulk import · code signing and a Windows build host for icon and version
metadata · IP whitelisting setup guidance (deferred by the user) · watch **SRO 288(I)/2026**, the
most likely source of a near-term schema change.
