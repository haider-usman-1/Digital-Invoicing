# Roadmap

The living list of what this app doesn't do yet. v1 is deliberately the bare minimum: file a Sale
Invoice to FBR and get the IRN back. Everything below was considered and consciously deferred.

Add to this file rather than growing v1 — that was the point of keeping it.

## Open questions FBR doesn't document

These are **not** design decisions we can make. Each is an assumption currently baked into the code
with a comment, to be resolved by probing sandbox with a real token. Record the answer here when you
learn it.

| Question | Current assumption | Where it lives | Status |
|---|---|---|---|
| Is `totalValues: 0.00` accepted for ordinary sales? | Yes — every official sample sends `0.00`, and error 0085 scopes the field to PFAD | `src/core/calc.ts` | Unverified |
| What rounding mode does FBR use when it recalculates? | Half-up at 2dp | `src/core/calc.ts` (`round2`) | Unverified |
| Does discount apply before or after tax? | Tax is charged on value after discount | `src/core/calc.ts` | Unverified |
| For 3rd Schedule goods, is the tax base retail price × quantity? | Yes | `src/core/calc.ts` | Unverified |
| HTTP verb for `/dist/v1/Get_Reg_Type` and `/dist/v1/statl` | POST — the spec says GET but shows a JSON request body | `src/server/fbr-client.ts` | Unverified |
| Is province matching case-sensitive? | Send the exact string from the `provinces` endpoint | `src/core/payload.ts` | Unverified |
| Which STATL `status code` means Active? | Unknown; both of the spec's samples say "In-Active" | not yet used | Unverified |
| Max items per invoice, payload size, rate limits | No limit assumed; reference data cached aggressively | — | Undocumented |

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
