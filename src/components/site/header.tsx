import { LayoutDashboard, Repeat, Shield, Ticket, User } from "lucide-react";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import type { User as UserT } from "@/db/schema";
import { buttonClasses } from "@/components/ui";
import type { Theme } from "@/lib/theme";
import { Logo } from "./logo";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader({ user, hasOrganizerProfile, theme }: { user: UserT | null; hasOrganizerProfile: boolean; theme: Theme }) {
  // Staff areas only appear for the people who use them; prospective organizers find /organizer/apply from the footer.
  const showOrganizer = hasOrganizerProfile || user?.role === "organizer" || user?.role === "admin";
  const orgHref = hasOrganizerProfile ? "/organizer" : "/organizer/apply";
  return (
    <header className="theme-dark sticky top-0 z-30 bg-bg/95 text-fg backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-4 sm:h-[72px] sm:px-6">
        <Logo />
        <NavLinks
          items={[
            { href: "/events", label: "Explore events" },
            { href: "/account", label: "My tickets" },
            { href: "/resale", label: "Resale" },
            ...(showOrganizer ? [{ href: orgHref, label: "Organizer dashboard" }] : []),
            ...(user?.role === "admin" ? [{ href: "/admin", label: "Admin" }] : []),
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle initial={theme} />
          <Show when="signed-out">
            <SignInButton mode="redirect">
              <button className={buttonClasses("ghost", "sm")}>Sign in</button>
            </SignInButton>
            <SignUpButton mode="redirect">
              <button className={buttonClasses("primary", "sm")}>Sign up</button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            {user && <span className="hidden max-w-32 truncate text-[15px] font-medium text-fg/90 sm:inline">{user.name.split(" ")[0]}</span>}
            <UserButton appearance={{ elements: { avatarBox: "size-9" } }}>
              <UserButton.MenuItems>
                <UserButton.Link label="My tickets" labelIcon={<Ticket className="size-4" />} href="/account" />
                <UserButton.Link label="My resale listings" labelIcon={<Repeat className="size-4" />} href="/resale/mine" />
                <UserButton.Link label="Profile & phone" labelIcon={<User className="size-4" />} href="/account/profile" />
                {showOrganizer ? <UserButton.Link label="Organizer dashboard" labelIcon={<LayoutDashboard className="size-4" />} href={orgHref} /> : null}
                {user?.role === "admin" ? <UserButton.Link label="Admin" labelIcon={<Shield className="size-4" />} href="/admin" /> : null}
              </UserButton.MenuItems>
            </UserButton>
          </Show>
        </div>
      </div>
    </header>
  );
}
