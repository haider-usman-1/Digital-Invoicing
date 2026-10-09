/**
 * Captures screenshots of the running app, for visual review during UI work.
 *
 *     bun scripts/screenshot.ts <output-dir> [--port 7345]
 *
 * Development tooling, not part of the app: nothing in src/ imports it, so it never reaches the
 * compiled executable.
 *
 * Drives a headless Chrome over the DevTools Protocol rather than using `--screenshot`, because the
 * screens are client-side tabs with no URLs of their own — reaching them means actually clicking,
 * which is also the only way to see a screen in the state a user would.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = process.argv[2] ?? "/tmp/shots";
const portIndex = process.argv.indexOf("--port");
const appPort = portIndex > -1 ? Number(process.argv[portIndex + 1]) : 7345;
const DEBUG_PORT = 9333;

mkdirSync(outDir, { recursive: true });

const chrome = Bun.spawn(
  [
    CHROME,
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--user-data-dir=/tmp/chrome-shot-profile",
    "--window-size=1600,1000",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

/** CDP is ready only once the HTTP endpoint answers, which lags process start. */
async function waitForDevTools(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error("Chrome's DevTools endpoint never came up");
}

class Page {
  private socket!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (result: unknown) => void>();

  async open(url: string): Promise<void> {
    const target = await fetch(
      `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    ).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>);

    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("Couldn't attach to the page"));
    });

    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)!(message.result);
        this.pending.delete(message.id);
      }
    };
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve as (r: unknown) => void));
  }

  /** Runs an expression in the page and resolves its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const { result } = await this.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.value;
  }

  /** Clicks the first element whose text matches, the way a user would reach a tab. */
  async clickText(text: string): Promise<boolean> {
    return this.evaluate<boolean>(`
      (() => {
        const match = [...document.querySelectorAll('button, a, [role=tab]')]
          .find((el) => el.textContent?.trim().startsWith(${JSON.stringify(text)}));
        if (!match) return false;
        match.click();
        return true;
      })()
    `);
  }

  async screenshot(file: string, fullPage = true): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    });
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  close(): void {
    this.socket?.close();
  }
}

interface Shot {
  name: string;
  /** Capture only the viewport. Needed to see sticky elements where they actually sit. */
  viewport?: boolean;
  /** Tab label to click before capturing; omitted for the landing screen. */
  tab?: string;
  /** Extra in-page setup, e.g. opening a dialog. */
  prepare?: string;
}

const SHOTS: Shot[] = [
  { name: "01-new-invoice" },
  { name: "01b-new-invoice-viewport", viewport: true },
  {
    name: "02-dialog",
    // Exercises the submission modal, which is the one state no static view reaches.
    prepare: `[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Check without filing'))?.click()`,
  },
  { name: "03-scenarios", tab: "Scenario testing" },
  { name: "04-needs-checking", tab: "Needs checking" },
  { name: "05-settings", tab: "Settings" },
];

await waitForDevTools();

const page = new Page();
await page.open(`http://127.0.0.1:${appPort}/`);

await Bun.sleep(2500);

// Both palettes need checking. Driving the app's own control rather than emulating the OS setting,
// because the palette is resolved in script now and an explicit choice is what users actually make.
if (process.argv.includes("--light")) {
  await page.evaluate(
    `document.querySelector('[aria-label="Light theme"]')?.click()`,
  );
  await Bun.sleep(400);
}

for (const shot of SHOTS) {
  if (shot.tab) {
    const clicked = await page.clickText(shot.tab);
    if (!clicked) console.warn(`  ! couldn't find tab "${shot.tab}"`);
    await Bun.sleep(1200);
  }
  if (shot.prepare) {
    await page.evaluate(shot.prepare);
    await Bun.sleep(900);
  }
  // Dismiss anything the previous shot opened, so screens are captured in their resting state.
  if (!shot.prepare) {
    await page.evaluate(
      `[...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Close')?.click()`,
    );
  }
  const file = join(outDir, `${shot.name}.png`);
  await page.screenshot(file, !shot.viewport);
  console.log(`  ${shot.name}.png`);
}

page.close();
chrome.kill();
await Bun.sleep(300);
