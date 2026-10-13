import { ShieldAlert } from "lucide-react";
import { ButtonLink, EmptyState } from "@/components/ui";
import { authorizeBooking } from "@/server/bookings/authorize";
import { bookingPaymentView } from "@/server/bookings/payment-view";
import { StatusPoller } from "./status-poller";

export const metadata = { title: "Payment status" };

export default async function StatusPage({ params, searchParams }: PageProps<"/checkout/[ref]/status">) {
  const { ref } = await params;
  const { access: q } = await searchParams;
  const access = await authorizeBooking(ref, typeof q === "string" ? q : null);
  if (!access) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <EmptyState icon={<ShieldAlert className="size-6" />} title="Booking not found" body="Open the link from your confirmation email to view this booking." action={<ButtonLink href="/bookings/find">Find my booking</ButtonLink>} />
      </div>
    );
  }
  const { booking, token } = access;
  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-12 sm:pt-20">
      <StatusPoller reference={booking.reference} access={token} initial={await bookingPaymentView(booking)} />
    </div>
  );
}
