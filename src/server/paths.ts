/**
 * Where the app keeps its data.
 *
 * Everything lives in a `data` folder beside the executable (or beside the project when running
 * from source), so the app is portable: copy the folder and you have taken the accounts, the
 * submission history and the cached FBR reference lists with you, and there is exactly one thing to
 * back up.
 *
 * The trade-off, stated plainly: a per-user location like %APPDATA% gets user-scoped ACLs for free,
 * while a folder beside the exe inherits whatever the surrounding directory allows. `accounts.json`
 * holds long-lived FBR tokens (5 year validity), so keep the app somewhere only you can read —
 * your own Documents or Desktop, not a shared drive.
 *
 * Set FBR_DATA_DIR to override the location entirely.
 */

import { accessSync, constants, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DATA_DIR_NAME = "data";

/**
 * The directory the app actually lives in.
 *
 * In a compiled single-file build, source modules are served from a virtual filesystem (`/$bunfs`
 * on POSIX, `B:\~BUN` on Windows), so `import.meta.dir` is not a real path — the executable itself
 * is. Running from source, the project directory is the working directory.
 */
function appDir(): string {
  const dir = import.meta.dir;
  const compiled = dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]~BUN/.test(dir);
  return compiled ? dirname(process.execPath) : process.cwd();
}

export function dataDir(): string {
  return process.env.FBR_DATA_DIR ?? join(appDir(), DATA_DIR_NAME);
}

export function ensureDataDir(): string {
  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Can't write to ${dir}. The app stores its data beside itself, so move it somewhere you can ` +
        `write to — your Desktop or Documents rather than Program Files — or set FBR_DATA_DIR to ` +
        `another folder. (${reason})`,
    );
  }
  return dir;
}

export function dataFile(name: string): string {
  return join(ensureDataDir(), name);
}

/** Somewhere to report a startup failure when the data directory itself is the problem. */
export function fallbackLogFile(): string {
  return join(tmpdir(), "fbr-di-startup-error.log");
}

export const ACCOUNTS_FILE = "accounts.json";
export const REFERENCE_CACHE_FILE = "reference-cache.json";
export const SUBMISSIONS_FILE = "submissions.ndjson";
