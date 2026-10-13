import { redirect } from "next/navigation";
import { safeNext } from "@/lib/forms";

/** Legacy URL — sign-in is handled by Clerk. */
export default async function LoginRedirect({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const target = safeNext(next, "");
  redirect(target ? `/sign-in?redirect_url=${encodeURIComponent(target)}` : "/sign-in");
}
