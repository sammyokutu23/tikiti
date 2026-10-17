import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { BottomNav } from "@/components/site/bottom-nav";
import { SiteHeader } from "@/components/site/header";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { getCurrentUser, getOrganizerProfile } from "@/server/auth/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "TikoSoko — Event tickets in Kenya", template: "%s · TikoSoko" },
  description: "Discover concerts, festivals, conferences and more across Kenya. Book securely and get QR tickets instantly.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const organizer = user ? await getOrganizerProfile(user.id) : null;
  // Saved choice is rendered on the server, so there's no flash of the wrong theme.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en-KE"
      data-theme={theme === "system" ? undefined : theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ClerkProvider appearance={clerkAppearance}>
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
