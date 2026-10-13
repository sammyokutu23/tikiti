import Link from "next/link";
import { LayoutDashboard, Shield, Ticket, User } from "lucide-react";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import type { User as UserT } from "@/db/schema";
import { buttonClasses } from "@/components/ui";
import { Logo } from "./logo";

export function SiteHeader({ user, hasOrganizerProfile }: { user: UserT | null; hasOrganizerProfile: boolean }) {
  const orgHref = hasOrganizerProfile ? "/organizer" : "/organizer/apply";
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 text-sm md:flex">
          <Link href="/events" className="rounded-full px-3 py-2 text-fg/80 hover:bg-white/6 hover:text-fg">Explore events</Link>
          <Link href="/account" className="rounded-full px-3 py-2 text-fg/80 hover:bg-white/6 hover:text-fg">My tickets</Link>
          <Link href={orgHref} className="rounded-full px-3 py-2 text-fg/80 hover:bg-white/6 hover:text-fg">
            {hasOrganizerProfile ? "Organizer dashboard" : "Sell tickets"}
          </Link>
          {user?.role === "admin" && (
            <Link href="/admin" className="rounded-full px-3 py-2 text-fg/80 hover:bg-white/6 hover:text-fg">Admin</Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Show when="signed-out">
            <SignInButton mode="redirect">
              <button className={buttonClasses("ghost", "sm")}>Sign in</button>
            </SignInButton>
            <SignUpButton mode="redirect">
              <button className={buttonClasses("primary", "sm")}>Sign up</button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            {user && <span className="hidden max-w-32 truncate text-sm text-fg/80 sm:inline">{user.name.split(" ")[0]}</span>}
            <UserButton appearance={{ elements: { avatarBox: "size-9" } }}>
              <UserButton.MenuItems>
                <UserButton.Link label="My tickets" labelIcon={<Ticket className="size-4" />} href="/account" />
                <UserButton.Link label="Profile & phone" labelIcon={<User className="size-4" />} href="/account/profile" />
                <UserButton.Link
                  label={hasOrganizerProfile ? "Organizer dashboard" : "Become an organizer"}
                  labelIcon={<LayoutDashboard className="size-4" />}
                  href={orgHref}
                />
                {user?.role === "admin" ? <UserButton.Link label="Admin" labelIcon={<Shield className="size-4" />} href="/admin" /> : null}
              </UserButton.MenuItems>
            </UserButton>
          </Show>
        </div>
      </div>
    </header>
  );
}
