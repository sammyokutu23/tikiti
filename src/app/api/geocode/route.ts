import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser, getOrganizerProfile } from "@/server/auth/session";
import { GeocoderUnavailableError, searchVenues } from "@/server/geocoding";

/** Venue search for the organizer location picker. Organizers/admins only. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin" && !(await getOrganizerProfile(user.id))) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!rateLimit(`geocode:${user.id}`, 20, 60_000).ok) {
    return Response.json({ error: "Too many searches — wait a moment, or place the pin on the map." }, { status: 429 });
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    const results = await searchVenues(q);
    return Response.json({ results }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    const msg = err instanceof GeocoderUnavailableError ? err.message : "Venue search failed.";
    return Response.json({ error: `${msg} You can still place the pin on the map manually.` }, { status: 503 });
  }
}
