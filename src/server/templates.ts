/**
 * Persistence for scenario templates.
 *
 * Built-in defaults are unverified guesses, because nobody can verify an HS code / sale type / UoM
 * / rate combination without a sandbox token. Saved overrides are what make that acceptable: fix a
 * scenario once on the first account and every later account inherits the correction. With several
 * accounts each needing the same scenarios, that is where the time is actually saved.
 *
 * Overrides are global rather than per-account on purpose — FBR's requirements for a scenario don't
 * vary by registration, so a correction learned on one account is a correction for all of them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "./paths.ts";
import { defaultTemplate } from "../core/scenario-templates.ts";
import type { ScenarioTemplate } from "../core/scenario-templates.ts";

const TEMPLATES_FILE = "scenario-templates.json";

interface TemplatesFile {
  version: 1;
  /** Keyed by scenario id. Only scenarios the user has edited appear here. */
  overrides: Record<string, ScenarioTemplate>;
}

const emptyTemplatesFile = (): TemplatesFile => ({ version: 1, overrides: {} });

function read(): TemplatesFile {
  const path = dataFile(TEMPLATES_FILE);
  if (!existsSync(path)) return emptyTemplatesFile();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TemplatesFile;
  } catch {
    // A corrupt file must not stop invoicing — the built-in defaults still work.
    return emptyTemplatesFile();
  }
}

function write(file: TemplatesFile): void {
  writeFileSync(dataFile(TEMPLATES_FILE), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export interface ResolvedTemplate extends ScenarioTemplate {
  scenarioId: string;
  /** True when the user has saved their own version, so the UI can offer a reset. */
  customised: boolean;
}

export function loadTemplate(scenarioId: string): ResolvedTemplate {
  const id = scenarioId.trim().toUpperCase();
  const override = read().overrides[id];

  if (override) return { ...override, scenarioId: id, customised: true };
  return { ...defaultTemplate(id), scenarioId: id, customised: false };
}

export function loadTemplates(scenarioIds: string[]): ResolvedTemplate[] {
  return scenarioIds.map(loadTemplate);
}

export function saveTemplate(scenarioId: string, template: ScenarioTemplate): ResolvedTemplate {
  const id = scenarioId.trim().toUpperCase();
  const file = read();
  file.overrides[id] = template;
  write(file);
  return { ...template, scenarioId: id, customised: true };
}

/** Drops the saved override, returning the scenario to its built-in default. */
export function resetTemplate(scenarioId: string): ResolvedTemplate {
  const id = scenarioId.trim().toUpperCase();
  const file = read();
  delete file.overrides[id];
  write(file);
  return loadTemplate(id);
}
