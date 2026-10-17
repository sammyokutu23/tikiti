/**
 * Venue search (forward geocoding), proxied through our server so provider
 * config stays server-side and we can throttle + cache.
 *
 * Default provider: Nominatim (OpenStreetMap). Its public instance's usage
 * policy (https://operations.osmfoundation.org/policies/nominatim/) requires:
 *   - max 1 request/second, a descriptive User-Agent with contact info,
 *   - NO search-as-you-type autocomplete (we search only on explicit submit),
 *   - caching results, and OSM attribution.
 * It is not meant for heavy production use — point GEOCODER_URL at a
 * self-hosted Nominatim or a commercial provider before scaling.
 */
import { isValidLatLng, roundCoord } from "@/lib/location";

export type GeocodeResult = {
  id: string; // provider place id, e.g. "osm:node:5555074079"
  provider: string;
  name: string;
  address: string;
  city: string;
  displayName: string;
  lat: number;
  lng: number;
  type: string;
};

export class GeocoderUnavailableError extends Error {}

type Fetcher = typeof fetch;

const CACHE_TTL = 24 * 3600_000;
const cache = new Map<string, { at: number; results: GeocodeResult[] }>();
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** Serialises provider calls ≥1.1 s apart (Nominatim policy: ≤1 req/s per app). */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export type NominatimItem = {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  type?: string;
  address?: Record<string, string>;
};

export function normalizeNominatim(items: NominatimItem[]): GeocodeResult[] {
  return items
    .map((it) => {
      const lat = Number(it.lat);
      const lng = Number(it.lon);
      if (!isValidLatLng(lat, lng)) return null;
      const a = it.address ?? {};
      const street = [a.house_number, a.road].filter(Boolean).join(" ");
      const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || "";
      const city = a.city || a.town || a.municipality || a.village || a.county || a.state || "";
      const name = it.name || street || it.display_name.split(",")[0];
      const address = [street && street !== name ? street : "", area].filter(Boolean).join(", ");
      return {
        id: it.osm_type && it.osm_id ? `osm:${it.osm_type}:${it.osm_id}` : `nominatim:${it.place_id}`,
        provider: "nominatim",
        name,
        address,
        city: city.replace(/ (County|City)$/, ""),
        displayName: it.display_name,
        lat: roundCoord(lat),
        lng: roundCoord(lng),
        type: it.type ?? it.category ?? "place",
      } satisfies GeocodeResult;
    })
    .filter((r): r is GeocodeResult => r !== null);
}

export async function searchVenues(query: string, fetcher: Fetcher = fetch): Promise<GeocodeResult[]> {
  const q = query.trim().replace(/\s+/g, " ").slice(0, 120);
  if (q.length < 3) return [];
  const provider = process.env.GEOCODER_PROVIDER ?? "nominatim";
  if (provider === "disabled") throw new GeocoderUnavailableError("Venue search is not configured.");
  if (provider !== "nominatim") throw new GeocoderUnavailableError(`Unknown GEOCODER_PROVIDER ${provider}`);

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.results;

  const base = (process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
  const contact = process.env.GEOCODER_CONTACT_EMAIL || "dev@localhost";
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "6");
  url.searchParams.set("countrycodes", "ke"); // Kenyan market
  url.searchParams.set("accept-language", "en");
  url.searchParams.set("email", contact);

  const results = await throttled(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetcher(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": `TikoSokoTicketing/0.1 (${contact})`, Accept: "application/json" },
      });
      if (!res.ok) throw new GeocoderUnavailableError(`Venue search failed (${res.status}).`);
      return normalizeNominatim((await res.json()) as NominatimItem[]);
    } catch (err) {
      if (err instanceof GeocoderUnavailableError) throw err;
      throw new GeocoderUnavailableError("Venue search is temporarily unavailable.");
    } finally {
      clearTimeout(timer);
    }
  });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), results });
  return results;
}

export function _clearGeocodeCache() {
  cache.clear();
}
