import { Card, PageHeader } from "@/components/ui";
import { formatPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";
import { ProfileForm } from "./forms";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireUser("/account/profile");
  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <PageHeader title="Profile" subtitle="Manage your account details." />
      <div className="space-y-6">
        <Card className="p-5 sm:p-6">
          <ProfileForm name={user.name} email={user.email} phone={user.phone ? formatPhone(user.phone) : ""} />
        </Card>
      </div>
    </div>
  );
}
