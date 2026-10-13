"use client";

import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_ATTRIBUTION, MAP_TILE_URL } from "@/lib/location";

let loading: Promise<typeof Leaflet> | null = null;

/** Loads Leaflet on demand (it touches `window`, and most pages never need it). */
export function loadLeaflet(): Promise<typeof Leaflet> {
  loading ??= import("leaflet").then((m) => (m as unknown as { default?: typeof Leaflet }).default ?? (m as typeof Leaflet));
  return loading;
}

/** Self-contained SVG pin (avoids Leaflet's default image paths, which break under bundlers). */
export function pinIcon(L: typeof Leaflet) {
  return L.divIcon({
    className: "tikiti-pin",
    html: `<svg viewBox="0 0 32 44" width="32" height="44" aria-hidden="true"><path d="M16 0C7.2 0 0 7 0 15.7 0 27.5 16 44 16 44s16-16.5 16-28.3C32 7 24.8 0 16 0Z" fill="#0a0a0b" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15.5" r="6" fill="#fff"/></svg>`,
    iconSize: [32, 44],
    iconAnchor: [16, 44],
    popupAnchor: [0, -40],
  });
}

export function addTiles(L: typeof Leaflet, map: Leaflet.Map, onError?: () => void) {
  let errors = 0;
  const layer = L.tileLayer(MAP_TILE_URL, { maxZoom: 19, attribution: MAP_ATTRIBUTION, crossOrigin: true });
  layer.on("tileerror", () => {
    errors++;
    if (errors === 6) onError?.();
  });
  layer.addTo(map);
  return layer;
}
