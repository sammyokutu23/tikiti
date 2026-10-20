import { MessageCircle, QrCode, Repeat, Smartphone } from "lucide-react";
import { ButtonLink } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Spark, Underline } from "./doodles";

const CHAPTERS = [
  {
    icon: MessageCircle,
    tone: "bg-sun/25 text-fg",
    kicker: "It starts in the group chat",
    title: "“Mnaenda?”",
    body: "Someone drops a poster and the plans begin. Find concerts, festivals, comedy nights, matches and conferences across Kenya in one place.",
  },
  {
    icon: Smartphone,
    tone: "bg-teal/15 text-teal",
    kicker: "Then you shika ticket",
    title: "Pay with M-Pesa in seconds",
    body: "Your ticket arrives with its own QR code, in your inbox and in My tickets. No screenshots, no “send me the money first”.",
  },
  {
    icon: QrCode,
    tone: "bg-coral/15 text-coral",
    kicker: "The night arrives",
    title: "Scan in, no stress",
    body: "Show your QR at the gate and you're in. Each code works once, so nobody else walks in on your ticket.",
  },
  {
    icon: Repeat,
    tone: "bg-fg/8 text-fg",
    kicker: "Plans changed?",
    title: "Pass it on to another fan",
    body: "List your ticket on TikoSoko Resale. The buyer gets a fresh or checked ticket, and you're paid on M-Pesa after the event.",
  },
];

/** Home page story: why TikoSoko exists and how a night out flows through it. */
export function HomeStory() {
  return (
    <section aria-labelledby="story-title" className="relative space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="flex w-fit flex-col font-script text-2xl font-bold text-teal">
          <span>Our story</span>
          <Underline className="-mt-1 text-teal" />
        </p>
        <h2 id="story-title" className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          Every great night out starts with a ticket you can trust.
        </h2>
        <p className="text-muted sm:text-lg">
          <b className="text-fg">Soko</b> means market. We built TikoSoko because too many fans paid for fake tickets and forwarded screenshots on WhatsApp and Instagram.
          Here, every ticket is real, every resale is checked, and a seller&apos;s money is held until after the show.
        </p>
      </div>

      <ol className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Spark className="absolute -right-2 -top-6 hidden size-7 rotate-180 text-coral lg:block" />
        {CHAPTERS.map((c, i) => (
          <li key={c.title} className="relative flex flex-col gap-3 rounded-3xl border border-line bg-surface/70 p-5">
            <div className="flex items-center justify-between">
              <span className={cn("flex size-11 items-center justify-center rounded-2xl", c.tone)}>
                <c.icon className="size-5" aria-hidden />
              </span>
              <span className="font-script text-3xl font-bold text-fg/20" aria-hidden>
                {i + 1}
              </span>
            </div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{c.kicker}</p>
            <h3 className="text-lg font-bold leading-snug">{c.title}</h3>
            <p className="text-sm text-muted">{c.body}</p>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href="/events" size="lg">Find your next plan</ButtonLink>
        <ButtonLink href="/resale" size="lg" variant="secondary">
          <Repeat className="size-4" aria-hidden /> Resale tickets
        </ButtonLink>
      </div>
    </section>
  );
}
