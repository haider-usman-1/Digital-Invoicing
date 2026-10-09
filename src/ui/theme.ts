/**
 * Colour mode.
 *
 * The preference is resolved in script rather than by `@media (prefers-color-scheme)` alone, so an
 * explicit choice can override the OS. `data-theme` on <html> is therefore ALWAYS one of "light" or
 * "dark" — never absent — which keeps the stylesheet down to two token blocks with no media query
 * and no duplicated declarations.
 *
 * Stored in localStorage: this is a view preference, not business data, and it has no place in the
 * app's data directory next to accounts and submission history.
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "fbr-di:theme";

export function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private mode or a locked-down profile; falling back to the OS is the right default anyway.
  }
  return "system";
}

function systemPrefersLight(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return systemPrefersLight() ? "light" : "dark";
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
}

export function savePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not worth failing a theme change over; it just will not persist.
  }
  applyTheme(preference);
}

/**
 * Applies the stored preference and keeps "system" in step with the OS afterwards.
 *
 * Returns an unsubscribe so a caller can tear the listener down; the app itself lives for the
 * lifetime of the page, so it does not.
 */
export function initTheme(): () => void {
  applyTheme(loadPreference());

  const media = globalThis.matchMedia?.("(prefers-color-scheme: light)");
  if (!media) return () => {};

  const onChange = () => {
    if (loadPreference() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
