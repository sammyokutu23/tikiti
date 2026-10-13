import { SignUp } from "@clerk/nextjs";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <div className="flex flex-col items-center gap-6">
      <SignUp />
      <p className="max-w-sm text-center text-xs text-subtle">
        Used the same email for guest bookings? Verify it here and those bookings can be added to your account from the booking link.
      </p>
    </div>
  );
}
