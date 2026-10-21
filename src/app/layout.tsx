import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearance, clerkLocalization } from "@/lib/clerk-appearance";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Caveat, Geist, Geist_Mono } from "next/font/google";
import { BottomNav } from "@/components/site/bottom-nav";
import { SiteHeader } from "@/components/site/header";
import { LEGACY_THEME_COOKIE, THEME_COOKIE, parseTheme } from "@/lib/theme";
import { getCurrentUser, getOrganizerProfile } from "@/server/auth/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const caveat = Caveat({ variable: "--font-caveat", subsets: ["latin"], weight: ["600", "700"] });

export const metadata: Metadata = {
  title: { default: "TikoSoko — Event tickets in Kenya", template: "%s · TikoSoko" },
  description: "Discover concerts, festivals, conferences and more across Kenya. Book securely and get QR tickets instantly.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0908" },
    { media: "(prefers-color-scheme: light)", color: "#faf5ee" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const organizer = user ? await getOrganizerProfile(user.id) : null;
  // Saved choice is rendered on the server, so there's no flash of the wrong theme.
  const jar = await cookies();
  const theme = parseTheme((jar.get(THEME_COOKIE) ?? jar.get(LEGACY_THEME_COOKIE))?.value);
  return (
    <html
      lang="en-KE"
      data-theme={theme === "system" ? undefined : theme}
      className={`${geistSans.variable} ${geistMono.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ClerkProvider appearance={clerkAppearance} localization={clerkLocalization}>
          <a href="#main" className="sr-only z-50 rounded-full bg-primary px-4 py-2 text-primary-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
          Skip to content
          </a>
          <SiteHeader user={user} hasOrganizerProfile={!!organizer} theme={theme} />
          <div id="main" className="flex flex-1 flex-col">
          {children}
          </div>
          <BottomNav />
        </ClerkProvider>
      </body>
    </html>
  );
}
