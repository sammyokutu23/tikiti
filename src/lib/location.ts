/** Shared (client + server) location helpers. Coordinates are WGS84 decimal degrees. */

export type LatLng = { lat: number; lng: number };

/** Rough bounding box for Kenya — used to bias search and flag out-of-country pins. */
export const KENYA_BOUNDS = { south: -4.9, west: 33.9, north: 5.1, east: 42.0 };
/** Neutral starting view for the picker only (never rendered as an event marker). */
export const KENYA_CENTER: LatLng = { lat: 0.2, lng: 37.9 };

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0) // "Null Island" is almost always a bug, not a venue
  );
}

export function eventCoordinates(e: { latitude: number | null; longitude: number | null }): LatLng | null {
  return isValidLatLng(e.latitude, e.longitude) ? { lat: e.latitude!, lng: e.longitude! } : null;
}

export function isInKenya({ lat, lng }: LatLng) {
  return lat >= KENYA_BOUNDS.south && lat <= KENYA_BOUNDS.north && lng >= KENYA_BOUNDS.west && lng <= KENYA_BOUNDS.east;
}

/** 6 decimals ≈ 11 cm — more than enough for an entrance pin. */
export function roundCoord(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

export function formatCoords({ lat, lng }: LatLng) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * Google Maps directions to the exact saved pin (Maps URLs API — no key needed,
 * works on mobile apps and desktop, and does not ask for the user's location).
 */
export function directionsUrl({ lat, lng }: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${roundCoord(lat)},${roundCoord(lng)}`;
}

/** Map search by text — only for events without a pin, and labelled as approximate. */
export function mapsSearchUrl(parts: (string | null | undefined)[]): string {
  const q = parts.filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export const MAP_TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const MAP_ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
