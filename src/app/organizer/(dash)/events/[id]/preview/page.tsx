import { notFound } from "next/navigation";
import { EventDetailView } from "@/components/events/event-detail";
import { Alert } from "@/components/ui";
import { getEventPreview } from "@/server/events/queries";
import { organizerEventPage } from "@/server/organizers/access";

export const metadata = { title: "Preview" };

export default async function PreviewPage({ params }: PageProps<"/organizer/events/[id]/preview">) {
  const { id } = await params;
  const { event } = await organizerEventPage(id);
  const d = await getEventPreview(event.id);
  if (!d) notFound();
  return (
    <div className="-mx-4 sm:-mx-6">
      <div className="px-4 sm:px-6">
        <Alert tone="info" title="Preview">
          This is how buyers will see your event{event.status !== "published" ? " once it's published" : ""}. Checkout is disabled in preview.
        </Alert>
      </div>
      <EventDetailView detail={d} mode="preview" backHref={`/organizer/events/${event.id}`} disabledReason="Checkout is disabled in preview." />
    </div>
  );
}
