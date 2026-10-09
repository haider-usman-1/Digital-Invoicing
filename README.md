# FBR Digital Invoicing

A small local app for filing sales invoices to Pakistan's FBR Digital Invoicing (DI) system. Runs on
one machine, handles several seller registrations, and is built to be driven by someone who doesn't
know what an HS code is.

Double-click the executable, fill in one screen, get FBR's invoice reference number back — or a
plain-language explanation of what FBR rejected.

- **Running it on Windows:** [`docs/SETUP-WINDOWS.md`](docs/SETUP-WINDOWS.md)
- **What it doesn't do yet:** [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **Why it's built this way:** [`docs/superpowers/specs/`](docs/superpowers/specs/)

## Development

Requires [Bun](https://bun.sh). No other toolchain.

```sh
bun install
bun run dev        # mock mode, no network, no token needed → http://127.0.0.1:7345
bun test
bun run typecheck
bun run build:win  # single Windows .exe, cross-compiled from macOS
```

`bun run dev` starts in **mock mode**: FBR is never contacted, and canned responses cover every
branch. Put one of these words in a line item's description to exercise a path:

| Trigger in description | What FBR appears to do |
|---|---|
| anything else | files successfully, returns an IRN |
| `REJECT` | rejects one line item, in FBR's real response shape |
| `HEADERFAIL` | rejects the whole invoice |
| `TIMEOUT` | pre-check passes, then the filing goes ambiguous |
| `PRECHECKTIMEOUT` | the pre-check itself times out; nothing is filed |

## How it's laid out

```
src/core/      Pure, no I/O — the FBR rules that are expensive to get wrong
  payload.ts     builds the wire JSON field by field
  outcome.ts     decides whether FBR actually accepted the invoice
  calc.ts        computes line amounts, and declares when it can't
  errors.ts      FBR error codes → plain language + the field to highlight
  scenarios.ts   the 28 sandbox scenarios
  scenario-templates.ts  ready-to-post defaults per scenario (unverified; see below)
  endpoints.ts   endpoint URLs, written out literally
src/server/    Owns every FBR call; a token never reaches the browser
src/ui/        React, three screens, one hand-written stylesheet
tests/         Unit tests per core module, plus an end-to-end run against a real server
```

## Three things worth knowing before changing anything

**FBR's success response has a trap.** On an item-level rejection the *outer* `statusCode` is `"00"`
— the same value a success uses — and only the lowercase outer `status` and the item's own
`statusCode` reveal the failure. An invoice is only filed if an invoice number came back *and* every
item status is `"00"`. That rule lives in exactly one place, `src/core/outcome.ts`.

**There is no idempotency key and no read API.** A dropped connection genuinely means "this invoice
may or may not exist". That's why the submission log writes the attempt to disk *before* the request
goes out, why ambiguity is its own `uncertain` state rather than an error, and why resolving one
means a human checking the IRIS portal. Never turn that into an automatic retry.

**Some amounts cannot be calculated from FBR's own reference data.** Rates like `"18% along with
rupees 60 per kilogram"` expose only the `18` in `ratE_VALUE`; the rest exists solely in prose. 3rd
Schedule goods are taxed on retail price, not sale value. `calc.ts` returns a low-confidence result
with an explicit warning in those cases instead of a confident wrong number, and the UI lets the
user take over.

**The scenario templates have never been tested against FBR.** Every eligible scenario opens a
fully prefilled, submittable invoice, which is the only way the scenario screen earns its keep — but
the HS code, unit of measure and rate in each template are educated guesses, and FBR validates those
combinations server-side. That is acceptable only because corrections are savable: fix a scenario
once, press **Save these values as the template**, and every account after it starts from the
corrected version. Do not quietly "tidy" a template to look more confident than it is; fix it by
posting it.

Undocumented assumptions are listed in [`docs/ROADMAP.md`](docs/ROADMAP.md) with the code that
depends on them. Resolve them by probing sandbox, not by guessing.
