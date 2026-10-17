export const THEME_COOKIE = "tikosoko-theme";
/** Name used before the TikoSoko rebrand; still read so saved choices carry over. */
export const LEGACY_THEME_COOKIE = "tikiti-theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function parseTheme(v: string | undefined | null): Theme {
  return v === "light" || v === "dark" ? v : "system";
}
