import Link from "next/link";
import { SignIn } from "@clerk/nextjs";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="flex flex-col items-center gap-6">
      <SignIn />
      <p className="text-center text-xs text-subtle">
        Booked as a guest? <Link href="/bookings/find" className="underline">Find your booking</Link> — no account needed.
      </p>
    </div>
  );
}
