import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk only establishes the session here. Authorization stays in the app:
 * pages / actions / route handlers call requireUser / requireOrganizer /
 * requireAdmin (src/server/auth/guards.ts), which map the Clerk user to our
 * local user record and its role.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
