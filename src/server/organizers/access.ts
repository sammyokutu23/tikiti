import { NotFoundError } from "@/lib/errors";
import { notFound } from "next/navigation";
import { requireOrganizer, requireOwnedEvent } from "../auth/guards";

/** Organizer + owned event for pages; renders 404 for other organizers' events. */
export async function organizerEventPage(id: string) {
  const ctx = await requireOrganizer();
  try {
    const event = await requireOwnedEvent(id, ctx);
    return { ...ctx, event };
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
}
