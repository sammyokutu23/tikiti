import { CalendarX } from "lucide-react";
import { ButtonLink, EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <EmptyState
        icon={<CalendarX className="size-6" />}
        title="Event not found"
        body="This event may have been unpublished or the link is incorrect."
        action={<ButtonLink href="/events">Browse events</ButtonLink>}
      />
    </div>
  );
}
