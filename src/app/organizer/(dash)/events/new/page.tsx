import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireOrganizer } from "@/server/auth/guards";
import { EventForm } from "@/app/organizer/event-forms";

export const metadata = { title: "New event" };

export default async function NewEventPage() {
  await requireOrganizer();
  return (
    <div className="max-w-3xl">
      <PageHeader back={<Link href="/organizer/events" className="text-sm text-muted hover:text-fg">← Events</Link>} title="New event" subtitle="Events start as drafts. Add ticket types, preview, then publish." />
      <EventForm
        defaults={{
          timezone: "Africa/Nairobi",
          refundPolicy: "Tickets are refundable up to 7 days before the event. If the event is cancelled you'll receive a full refund automatically.",
        }}
      />
    </div>
  );
}
