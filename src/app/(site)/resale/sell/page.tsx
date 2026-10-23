import Link from "next/link";
import { ArrowRight, Globe, Ticket } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/guards";

export const metadata = { title: "Sell a ticket" };

const CHOICES = [
  {
    href: "/resale/sell/tikosoko",
    icon: Ticket,
    tone: "bg-mint text-[#3a2500]",
    title: "A ticket I bought on TikoSoko",
    body: "Pick it from your purchases and set a price. It goes live straight away.",
  },
  {
    href: "/resale/sell/outside",
    icon: Globe,
    tone: "bg-sun text-[#2a1d00]",
    title: "A ticket I bought somewhere else",
    body: "Mookh, Ticketsasa, the organizer… Upload it with your proof of purchase. Our team reviews it before it goes live.",
  },
];

export default async function SellTicketPage() {
  await requireUser("/resale/sell");
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <PageHeader title="Sell a ticket" subtitle="Where did you buy the ticket you'd like to sell?" />
      <div className="grid gap-4 sm:grid-cols-2">
        {CHOICES.map(({ href, icon: Icon, tone, title, body }) => (
          <Link key={href} href={href} className="group flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 transition hover:-translate-y-0.5 hover:border-teal/40 hover:shadow-lg">
            <span className={`flex size-12 items-center justify-center rounded-2xl ${tone}`}>
              <Icon className="size-6" aria-hidden />
            </span>
            <span className="space-y-1">
              <span className="block text-lg font-bold">{title}</span>
              <span className="block text-sm text-muted">{body}</span>
            </span>
            <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-semibold text-teal">
              Continue <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden />
            </span>
          </Link>
        ))}
      </div>
      <p className="text-sm text-muted">You get your full asking price on M-Pesa after the event. Buyers pay a 10% fee on top.</p>
    </div>
  );
}
