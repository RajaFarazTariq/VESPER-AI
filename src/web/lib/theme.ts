export type ThemePreference = "system" | "light" | "dark";

const KEY = "theme";

/** Dark is the default (owner's choice, v0.9.8); a theme someone picked in Settings is kept. */
export const DEFAULT_THEME: ThemePreference = "dark";

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // storage unavailable (private mode etc.)
  }
  return DEFAULT_THEME;
}

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(preference: ThemePreference): void {
  const dark = preference === "dark" || (preference === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    // ignore
  }
  applyTheme(preference);
}

/** Apply the saved theme now and follow OS changes while on "system". */
export function initTheme(): void {
  applyTheme(getThemePreference());
  media().addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}
