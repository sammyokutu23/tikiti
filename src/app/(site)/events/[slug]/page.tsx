import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EventDetailView } from "@/components/events/event-detail";
import { getPublicEvent } from "@/server/events/queries";

export async function generateMetadata({ params }: PageProps<"/events/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const d = await getPublicEvent(slug);
  return d ? { title: d.event.title, description: d.event.summary || undefined } : { title: "Event not found" };
}

export default async function EventPage({ params }: PageProps<"/events/[slug]">) {
  const { slug } = await params;
  const detail = await getPublicEvent(slug);
  if (!detail) notFound();
  return <EventDetailView detail={detail} mode="public" />;
}
