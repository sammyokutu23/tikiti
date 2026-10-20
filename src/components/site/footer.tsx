import Link from "next/link";
import { Logo } from "./logo";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line pb-28 md:pb-10">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-4 sm:px-6">
        <div className="space-y-3 sm:col-span-2">
          <Logo tagline />
          <p className="max-w-sm text-sm text-muted">
            Discover concerts, festivals, conferences and more across Kenya. Secure tickets with unique QR codes, delivered to your inbox.
          </p>
          <p className="text-xs text-subtle">Prototype — payments are simulated. No real money is charged.</p>
        </div>
        <div className="space-y-2 text-sm">
          <p className="font-semibold">Attend</p>
          <Link href="/events" className="block text-muted hover:text-fg">Browse events</Link>
          <Link href="/bookings/find" className="block text-muted hover:text-fg">Find my booking</Link>
          <Link href="/account" className="block text-muted hover:text-fg">My tickets</Link>
          <Link href="/resale" className="block text-muted hover:text-fg">Resale marketplace</Link>
          <Link href="/resale/sell" className="block text-muted hover:text-fg">Sell your ticket</Link>
        </div>
        <div className="space-y-2 text-sm">
          <p className="font-semibold">Organize</p>
          <Link href="/organizer/apply" className="block text-muted hover:text-fg">Sell tickets on TikoSoko</Link>
          <Link href="/organizer" className="block text-muted hover:text-fg">Organizer dashboard</Link>
        </div>
      </div>
    </footer>
  );
}
