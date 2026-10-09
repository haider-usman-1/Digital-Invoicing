# Running it on Windows

## Building the executable (on the Mac)

```sh
bun run build:win
```

Produces `dist/FBR-Invoicing.exe` — a single self-contained file, around 83 MB. Nothing needs to be
installed on the Windows machine: no Bun, no Node, no runtime.

Copy that one file across.

## First run

Double-click `FBR-Invoicing.exe`. It starts a small server on this machine only and opens your
default browser. There's no console window.

**The first launch will show a blue "Windows protected your PC" screen.** This is SmartScreen
reacting to an executable it hasn't seen signed before — not a virus warning. Click **More info**,
then **Run anyway**. It won't ask again on this machine.

Windows Defender occasionally flags freshly built executables like this one on heuristics alone. If
that happens, allow it through Defender's list. The permanent fix is a code-signing certificate,
which is on the roadmap.

## Using it

- **Closing the browser tab doesn't stop the app.** Use the **Quit** button in the top right.
- **Double-clicking the icon again is safe.** If the app is already running it just reopens the
  browser tab rather than starting a second copy.
- Your data lives in a `data` folder **next to the .exe**:
  - `accounts.json` — seller details and your FBR tokens
  - `submissions.ndjson` — a record of every invoice submitted
  - `reference-cache.json` — FBR's HS code and rate lists, cached
  - `scenario-templates.json` — your saved scenario template corrections
  - `startup-error.log` — only appears if the app failed to start

**Keep the .exe and its `data` folder together.** Moving them as a pair moves the whole
installation — accounts, history and all. That also means two things to watch:

- **Put it somewhere you can write to.** Your Desktop or Documents is fine; `Program Files` is not,
  and the app will say so rather than failing silently.
- **`accounts.json` holds your FBR tokens**, which are valid for five years. Don't put the folder on
  a shared drive or anywhere colleagues can read it.

Back up the `data` folder if you care about the submission history. Uninstalling means deleting the
`.exe` and that folder.

## Before the first real invoice

Three things have to be in place on FBR's side, and none of them are something this app can do for
you:

1. **A token for each account**, pasted into Settings. Sandbox tokens come from IRIS → Digital
   Invoicing → Sandbox Environment → View Web API Environment Details. Production tokens are issued
   automatically once an account has passed every one of its eligible scenarios.

2. **This machine's public IP whitelisted in IRIS.** FBR refuses calls from any other address, no
   matter how valid the token is — you'd see a 401. IRIS accepts 1 to 3 addresses per registration
   and PRAL approves them within about two working hours.

   Find the machine's public address by visiting a site like `ifconfig.me` from it. **If the
   connection has a dynamic IP, this will break every time the address changes** — worth sorting out
   with the ISP before relying on the app daily.

3. **Eligible scenarios ticked per account**, copied from that account's IRIS dashboard. The app
   can't derive them: FBR's published Business-Nature × Sector matrix has duplicate and missing
   rows, and the dashboard is the authoritative list.

## Sandbox first

Keep the environment switch on **Sandbox** until you're happy with the output. The banner across the
top is amber in sandbox and red in production, and it's never hidden.

This matters because a production filing is close to irreversible: FBR has no cancel API.
Corrections are portal-only, must happen within 72 hours, can't touch the invoice header, and are
capped at 10% of last month's sales across all amendments combined.

## If something goes wrong

**Nothing happens when you double-click.** Check `data\startup-error.log` next to the .exe (or
`%TEMP%\fbr-di-startup-error.log` if the app couldn't write there at all). The usual
cause is another program holding port 7345; set a different one by creating a shortcut whose target
is `FBR-Invoicing.exe` with the environment variable `PORT` set.

**Every invoice fails with a 401.** Either the token is wrong for the environment you've selected, or
this machine's IP isn't whitelisted. The error message distinguishes them.

**An invoice shows "we can't tell whether this was filed".** Don't re-submit. Open the **Needs
checking** tab, which lists the exact details to search for in the IRIS portal, and record what you
find. A duplicate filing is much harder to undo than a missing one.
