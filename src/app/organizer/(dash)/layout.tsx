import { DashShell } from "@/components/dash/shell";
import { StatusBadge } from "@/components/ui";
import { requireOrganizer } from "@/server/auth/guards";

export default async function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const { organizer } = await requireOrganizer();
  return (
    <DashShell
      title={organizer.displayName}
      badge={<StatusBadge status={organizer.verificationStatus} />}
      items={[
        { href: "/organizer", label: "Overview", exact: true },
        { href: "/organizer/events", label: "Events" },
        { href: "/organizer/bookings", label: "Bookings" },
      ]}
    >
      {children}
    </DashShell>
  );
}
