import Link from "next/link";
import { ChevronRight, LayoutDashboard, Repeat, Shield } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { formatPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";
import { getOrganizerProfile } from "@/server/auth/session";
import { ProfileForm } from "./forms";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireUser("/account/profile");
  const organizer = await getOrganizerProfile(user.id);
  // Same rules as the header's profile menu; on phones this page is where the bottom bar's Profile tab lands.
  const showOrganizer = !!organizer || user.role === "organizer" || user.role === "admin";
  const links = [
    { href: "/resale/mine", label: "My resale listings", icon: Repeat },
    ...(showOrganizer ? [{ href: organizer ? "/organizer" : "/organizer/apply", label: "Organizer dashboard", icon: LayoutDashboard }] : []),
    ...(user.role === "admin" ? [{ href: "/admin", label: "Admin dashboard", icon: Shield }] : []),
  ];
  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <PageHeader title="Profile" subtitle="Manage your account details." />
      <div className="space-y-6">
        <Card className="p-5 sm:p-6">
          <ProfileForm name={user.name} email={user.email} phone={user.phone ? formatPhone(user.phone) : ""} />
        </Card>
        <Card className="divide-y divide-line overflow-hidden">
          {links.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className="flex items-center gap-3 px-5 py-4 font-medium transition hover:bg-fg/5 sm:px-6">
              <Icon className="size-5 text-teal" aria-hidden />
              <span className="flex-1">{label}</span>
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </Link>
          ))}
        </Card>
      </div>
    </div>
  );
}
