import { FindBookingForm } from "../forms";

export const metadata = { title: "Find my booking" };

export default function FindBookingPage() {
  return (
    <div className="mx-auto max-w-md space-y-6 px-4 pb-24 pt-10 sm:pt-16">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Find my booking</h1>
        <p className="text-sm text-muted">
          Booked as a guest? Enter your email and booking reference and we&apos;ll email you a private link to your tickets. For your security we never show bookings from the reference alone.
        </p>
      </div>
      <FindBookingForm />
    </div>
  );
}
