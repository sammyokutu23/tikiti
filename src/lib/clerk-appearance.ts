/**
 * Clerk component theme. Colours point at the TikoSoko design tokens (globals.css),
 * so sign-in / sign-up / the user menu follow the light or dark theme automatically.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-fg)",
    colorBackground: "var(--bg-elevated)",
    colorForeground: "var(--fg)",
    colorMutedForeground: "var(--fg-muted)",
    colorInput: "var(--surface-2)",
    colorInputForeground: "var(--fg)",
    colorNeutral: "var(--fg)",
    colorDanger: "var(--danger)",
    colorSuccess: "var(--success)",
    borderRadius: "1rem",
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    card: "border border-line shadow-2xl",
    formButtonPrimary: "rounded-full",
    socialButtonsBlockButton: "rounded-full",
  },
};

/**
 * Clerk wording overrides. Its default titles use the Clerk application name,
 * which still says "tikiti" in the dashboard, so the brand is set here instead.
 */
export const clerkLocalization = {
  signIn: { start: { title: "Sign in to TikoSoko", titleCombined: "Continue to TikoSoko" } },
  signUp: { start: { title: "Create your TikoSoko account", titleCombined: "Continue to TikoSoko" } },
};
