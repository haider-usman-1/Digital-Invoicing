/**
 * Where the app keeps its data.
 *
 * Under the user profile rather than beside the executable: the profile directory has user-scoped
 * ACLs by default, while an .exe sitting in Downloads or a shared folder may not. The tokens stored
 * here are long-lived (FBR issues them with a 5 year validity), so this is worth getting right even
 * though the user chose plain-file storage over a password prompt.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const APP_DIR_NAME = "fbr-di";

export function dataDir(): string {
  const override = process.env.FBR_DATA_DIR;
  if (override) return override;

  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, APP_DIR_NAME);
  }

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }

  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, APP_DIR_NAME);
}

export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataFile(name: string): string {
  return join(ensureDataDir(), name);
}

export const ACCOUNTS_FILE = "accounts.json";
export const REFERENCE_CACHE_FILE = "reference-cache.json";
export const SUBMISSIONS_FILE = "submissions.ndjson";
