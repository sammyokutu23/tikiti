import { ShieldAlert } from "lucide-react";
import { ButtonLink, EmptyState } from "@/components/ui";
import { authorizeBooking } from "@/server/bookings/authorize";
import { planPaymentStatus } from "@/server/plans/service";
import { PlanPaymentPoller } from "../../../plan-forms";

export const metadata = { title: "Installment status", robots: { index: false } };

export default async function PlanPaymentStatusPage({ params, searchParams }: PageProps<"/bookings/[ref]/plan/status">) {
  const { ref } = await params;
  const sp = await searchParams;
  const access = await authorizeBooking(ref, typeof sp.access === "string" ? sp.access : null);
  const paymentId = typeof sp.payment === "string" ? sp.payment : "";
  if (!access) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <EmptyState icon={<ShieldAlert className="size-6" />} title="Booking not found" body="Open the link from your email to view this booking." action={<ButtonLink href="/bookings/find">Find my booking</ButtonLink>} />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-12 sm:pt-20">
      <PlanPaymentPoller reference={ref} paymentId={paymentId} access={access.token} initial={await planPaymentStatus(access.booking, paymentId)} />
    </div>
  );
}
