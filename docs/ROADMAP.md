# Roadmap

The living list of what this app doesn't do yet. v1 is deliberately the bare minimum: file a Sale
Invoice to FBR and get the IRN back. Everything below was considered and consciously deferred.

Add to this file rather than growing v1 — that was the point of keeping it.

## Open questions FBR doesn't document

These are **not** design decisions we can make. Each is an assumption currently baked into the code
with a comment, to be resolved by probing sandbox with a real token. Record the answer here when you
learn it.

### Answered by a real production filing

On 2026-10-09 a five-item production invoice was accepted (IRN `4987622DI1CFGJK395794`). Its
payload settles several questions that had been guesses:

| Question | Answer | Evidence |
|---|---|---|
| Is `totalValues: 0.00` accepted for ordinary sales? | **Yes.** All five items sent `0` alongside real `valueSalesExcludingST` figures | Accepted in production |
| Is province matching case-sensitive? | **No.** `buyerProvince: "PUNJAB"` and `sellerProvince: "Punjab"` were accepted on the same invoice | Accepted in production |
| Is `invoiceRefNo: ""` right for a sale invoice? | **Yes** | Accepted in production |
| Is omitting `scenarioId` right in production? | **Yes** | Accepted in production |
| What does an IRN actually look like? | `<NTN>DI<12 uppercase alphanumerics>` — e.g. `4987622DI1CFGJK395794`, 21 characters. **Not** the 13-digit epoch the spec's examples imply, nor the "22 digits" it states | Returned by FBR |
| Does FBR require `fixedNotifiedValueOrRetailPrice` for 3rd Schedule goods? | **Yes** — error: *"Fixed/Notified Value or Retail Price is mandatory... where sale type is 3rd Schedule Goods"* | Production rejection |
| Are 5 items on one invoice accepted? | **Yes** | Accepted in production |

Nothing validates IRN format, so the wrong assumption caused no bug — but the mock now generates
the real shape so it does not teach the wrong one.

### Still open

| Question | Current assumption | Where it lives | Status |
|---|---|---|---|
| What rounding mode does FBR use when it recalculates? | Half-up at 2dp | `src/core/calc.ts` (`round2`) | Unverified — the production invoice happened to divide exactly |
| Does discount apply before or after tax? | Tax is charged on value after discount | `src/core/calc.ts` | Unverified — no discount has been filed yet |
| For 3rd Schedule goods, is the tax base retail price × quantity? | Yes | `src/core/calc.ts` | Partly — FBR confirms the field is *required*, not yet the formula |
| HTTP verb for `/dist/v1/Get_Reg_Type` and `/dist/v1/statl` | POST — the spec says GET but shows a JSON request body | `src/server/fbr-client.ts` | Unverified |
| Which STATL `status code` means Active? | Unknown; both of the spec's samples say "In-Active" | not yet used | Unverified |
| Max items per invoice, payload size, rate limits | No limit assumed; reference data cached aggressively | — | Undocumented |
| Does any scenario template actually pass? | Each is a best guess; FBR validates HS code / sale type / UoM / rate agreement server-side (errors 0052, 0099, 0101) | `src/core/scenario-templates.ts` | **Unverified — none has ever been posted** |
| Is the shipped buyer NTN a registered taxpayer? | No. It is a number from FBR's documentation examples, so registered-buyer scenarios will fail with 0012/0053 until replaced | `src/core/scenario-templates.ts` | Known wrong, flagged in the UI |

Scenario templates are corrected in place: fix one on the first account, press **Save these values
as the template**, and every account after it inherits the correction. That is the mechanism that
makes shipping unverified guesses acceptable — and the fastest way to retire the two rows above is
to walk one account through its scenarios and save each one back.

## Deferred features

**Debit and credit notes.** Blocked on a genuine unknown: errors 0027/0028 prove FBR validates
`reason` and `reasonRemarks`, but the exact JSON keys appear in no published document. Probe sandbox
before building. Separately, "Credit Note" is not a documented `invoiceType` value and
`doctypecode` returns only Sale Invoice and Debit Note — how a credit note is filed at all is
unresolved. Notes must also reference FBR's IRN of the original (not the user's own number), fall
within 180 days, and only one credit note is allowed per invoice.

**Printable invoice / PDF with QR code.** FBR requires the DI logo and a QR code on every printed
invoice. Encode the IRN. There's an unresolved conflict to settle first: PRAL's technical spec says
QR version 2.0 (25×25) at 1.0 × 1.0 inch, while SRO 69(I)/2025 reportedly says 7 × 7 mm — and 7 mm
cannot reliably carry a 22–28 character payload at that version. The spec also lists a longer set of
required printed particulars (software registration number, SRO number against each HS code, and
more) that the current data model doesn't capture.

**Buyer and item catalogs.** Reusable buyer list, and an item list with default HS code, UoM and
rate, so a repeat invoice is a few clicks. The single biggest usability win still outstanding.

**Browsable invoice history.** The submission log already captures everything; this is the UI over
it — filter by account, date, status, buyer; export.

**The SRO field family.** `sroScheduleNo` and `sroItemSerialNo` are sent as empty strings today.
Supporting them properly needs four more reference endpoints: `sroitemcode`, `SroSchedule`,
`SROItem`, and `doctypecode`.

**CSV / Excel bulk import.** Only worth it if invoice volume grows; the current design targets a few
invoices a day.

## Packaging and operations

**Code signing.** The compiled `.exe` is unsigned, so Windows SmartScreen shows "Windows protected
your PC" on first run and Defender occasionally flags Bun-compiled binaries heuristically. Walked
through in `SETUP-WINDOWS.md`, but a signing certificate is the real fix.

**App icon and version metadata.** Not possible when cross-compiling from macOS — these need a
Windows build host. Add a Windows CI runner to get them.

**IP whitelisting guidance.** FBR only accepts calls from IPs whitelisted in IRIS (1–3 per
registration, approved within about 2 working hours). The user deferred this; it will need
documenting, and a dynamic IP would be a genuine blocker worth solving before it bites.

**Watch SRO 288(I)/2026.** A separate "Online Integration of Businesses" regime under the Income Tax
Rules, reportedly adding mandatory fields and digital signatures. The most likely source of a
near-term schema change. Its text was not obtainable at the time of writing.
