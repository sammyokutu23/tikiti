import { redirect } from "next/navigation";
import { BadgeCheck, FileEdit, Rocket } from "lucide-react";
import { Alert, Card } from "@/components/ui";
import { formatPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";
import { getOrganizerProfile } from "@/server/auth/session";
import { ApplyForm } from "./apply-form";

export const metadata = { title: "Become an organizer" };

export default async function ApplyPage() {
  const user = await requireUser("/organizer/apply");
  const profile = await getOrganizerProfile(user.id);
  if (profile && profile.verificationStatus !== "rejected") redirect("/organizer");
  return (
    <main className="mx-auto grid w-full max-w-5xl gap-10 px-4 pb-20 pt-8 sm:px-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Sell tickets on Tikiti</h1>
          <p className="text-muted">Tell us about your organization. You can start building draft events right away; we verify organizers before events go live.</p>
        </div>
        {profile?.verificationStatus === "rejected" && (
          <Alert tone="danger" title="Your previous application wasn't approved">{profile.verificationNote ?? "Update your details and resubmit."}</Alert>
        )}
        <ApplyForm
          defaults={{
            displayName: profile?.displayName ?? "",
            contactEmail: profile?.contactEmail ?? user.email,
            contactPhone: profile?.contactPhone ? formatPhone(profile.contactPhone) : user.phone ? formatPhone(user.phone) : "",
            city: profile?.city ?? "",
            website: profile?.website ?? "",
            bio: profile?.bio ?? "",
          }}
        />
      </div>
      <Card className="h-fit space-y-5 p-6 text-sm">
        {[
          [FileEdit, "1. Apply & draft", "Submit your details and start creating draft events immediately."],
          [BadgeCheck, "2. Get verified", "Our team reviews your profile, usually within one business day."],
          [Rocket, "3. Publish & sell", "Publish events, sell M-Pesa & card tickets and scan guests in."],
        ].map(([Icon, t, d]) => {
          const I = Icon as typeof FileEdit;
          return (
            <div key={t as string} className="flex gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white/8"><I className="size-5" aria-hidden /></span>
              <div><p className="font-semibold">{t as string}</p><p className="text-muted">{d as string}</p></div>
            </div>
          );
        })}
        <p className="border-t border-line pt-4 text-xs text-subtle">Platform commission: a percentage of paid ticket face value (currently 5%), shown on every booking. Free events carry no commission.</p>
      </Card>
    </main>
  );
}
