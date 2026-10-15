import { DashShell } from "@/components/dash/shell";
import { Badge } from "@/components/ui";
import { requireAdmin } from "@/server/auth/guards";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <DashShell
      title="Tikiti Admin"
      badge={<Badge tone="info">Staff</Badge>}
      items={[
        { href: "/admin", label: "Overview", exact: true },
        { href: "/admin/organizers", label: "Organizers" },
        { href: "/admin/events", label: "Events & reports" },
        { href: "/admin/bookings", label: "Bookings" },
        { href: "/admin/tickets", label: "Tickets & check-ins" },
        { href: "/admin/finance", label: "Finance" },
        { href: "/admin/users", label: "Users" },
        { href: "/admin/payment-plans", label: "Payment plans" },
        { href: "/admin/ai-banners", label: "AI banners" },
        { href: "/admin/operations", label: "Operations" },
        { href: "/admin/audit", label: "Audit log" },
      ]}
    >
      {children}
    </DashShell>
  );
}
