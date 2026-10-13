import { redirect } from "next/navigation";

/** Legacy URL — sign-up is handled by Clerk. */
export default function RegisterRedirect() {
  redirect("/sign-up");
}
