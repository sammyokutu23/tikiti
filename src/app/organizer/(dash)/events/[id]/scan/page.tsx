import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { attendanceStats } from "@/server/tickets/checkin";
import { organizerEventPage } from "@/server/organizers/access";
import { Scanner } from "./scanner";

export const metadata = { title: "Scan tickets" };

export default async function ScanPage({ params }: PageProps<"/organizer/events/[id]/scan">) {
  const { id } = await params;
  const { event } = await organizerEventPage(id);
  const s = await attendanceStats(event.id);
  return (
    <div>
      <PageHeader
        back={<Link href={`/organizer/events/${event.id}`} className="text-sm text-muted hover:text-fg">← {event.title}</Link>}
        title="Check-in"
        subtitle={`${s.checkedIn} of ${s.issued} valid tickets checked in. Every scan is verified on the server and logged under your account.`}
      />
      <Scanner eventId={event.id} />
    </div>
  );
}
