import { notFound } from "next/navigation";
import { getPublicEvent } from "@/server/events/queries";
import { ReportForm } from "./report-form";

export const metadata = { title: "Report event" };

export default async function ReportPage({ params }: PageProps<"/events/[slug]/report">) {
  const { slug } = await params;
  const d = await getPublicEvent(slug);
  if (!d) notFound();
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 pb-24 pt-10">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Report “{d.event.title}”</h1>
        <p className="text-sm text-muted">Reports go to the TikoSoko trust &amp; safety team. We review every report.</p>
      </div>
      <ReportForm eventId={d.event.id} />
    </div>
  );
}
