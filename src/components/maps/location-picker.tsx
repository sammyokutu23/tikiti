"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Crosshair, Loader2, MapPin, Search } from "lucide-react";
import { formatCoords, isInKenya, isValidLatLng, KENYA_CENTER, roundCoord, type LatLng } from "@/lib/location";
import { cn } from "@/lib/utils";
import { addTiles, loadLeaflet, pinIcon } from "./leaflet";

export type PickedPlace = { name: string; address: string; city: string };

type Result = { id: string; provider: string; name: string; address: string; city: string; displayName: string; lat: number; lng: number; type: string };

export type LocationValue = {
  pin: LatLng | null;
  confirmed: boolean;
  provider: "nominatim" | "manual";
  placeId: string;
};

/**
 * Venue location picker for the organizer event form. Search is explicit
 * (button / Enter) — no search-as-you-type, per the geocoder's usage policy.
 * The geocoded point is only a starting guess: the organizer drags / clicks to
 * refine it and must press "Confirm pin" before the form will save.
 */
export function LocationPicker({
  initial,
  error,
  onPlaceSelected,
  initialQuery,
}: {
  initial: LocationValue;
  error?: string;
  onPlaceSelected: (p: PickedPlace, overwrite: boolean) => void;
  initialQuery?: string;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerRef = useRef<import("leaflet").Marker | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);

  const [value, setValue] = useState<LocationValue>(initial);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");
  const lastSearch = useRef(0);

  const placePin = useCallback((p: LatLng, opts: { provider?: "nominatim" | "manual"; placeId?: string; fly?: boolean } = {}) => {
    const pin = { lat: roundCoord(p.lat), lng: roundCoord(p.lng) };
    setValue((v) => ({
      pin,
      confirmed: false,
      provider: opts.provider ?? v.provider,
      placeId: opts.provider === "manual" ? "" : (opts.placeId ?? v.placeId),
    }));
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    if (!markerRef.current) {
      const m = L.marker([pin.lat, pin.lng], { icon: pinIcon(L), draggable: true, keyboard: true, title: "Venue pin", alt: "Venue pin" }).addTo(map);
      m.on("dragend", () => {
        const ll = m.getLatLng();
        setValue((v) => ({ ...v, pin: { lat: roundCoord(ll.lat), lng: roundCoord(ll.lng) }, confirmed: false }));
      });
      markerRef.current = m;
    } else {
      markerRef.current.setLatLng([pin.lat, pin.lng]);
    }
    if (opts.fly) map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 17));
  }, []);

  // Initialise the map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const L = await loadLeaflet();
        if (cancelled || !mapEl.current) return;
        LRef.current = L;
        const start = initial.pin ?? KENYA_CENTER;
        const map = L.map(mapEl.current, { scrollWheelZoom: true, keyboard: true }).setView([start.lat, start.lng], initial.pin ? 17 : 6);
        addTiles(L, map, () => setMapState("error"));
        map.on("click", (e: import("leaflet").LeafletMouseEvent) => placePin(e.latlng, { provider: "manual" }));
        mapRef.current = map;
        if (initial.pin) placePin(initial.pin, { provider: initial.provider, placeId: initial.placeId });
        setValue(initial); // keep initial confirmation state for an unchanged saved pin
        setMapState("ready");
      } catch {
        if (!cancelled) setMapState("error");
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = async () => {
    const q = query.trim();
    if (q.length < 3) {
      setSearchError("Type at least 3 characters, e.g. “KICC Nairobi” or “Moi Avenue, Mombasa”.");
      return;
    }
    // Client-side guard against rapid repeat searches (the server also throttles).
    if (Date.now() - lastSearch.current < 1200) return;
    lastSearch.current = Date.now();
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Venue search failed.");
      setResults(data.results);
      setSelectedId(null);
    } catch (e) {
      setResults(null);
      setSearchError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const choose = (r: Result) => {
    setSelectedId(r.id);
    placePin({ lat: r.lat, lng: r.lng }, { provider: "nominatim", placeId: r.id, fly: true });
    onPlaceSelected({ name: r.name, address: r.address, city: r.city }, false);
  };

  const selected = results?.find((r) => r.id === selectedId) ?? null;
  const outsideKenya = value.pin && !isInKenya(value.pin);

  return (
    <div className="space-y-3">
      {/* hidden fields submitted with the event form */}
      <input type="hidden" name="latitude" value={value.pin ? String(value.pin.lat) : ""} />
      <input type="hidden" name="longitude" value={value.pin ? String(value.pin.lng) : ""} />
      <input type="hidden" name="locationConfirmed" value={value.confirmed ? "1" : ""} />
      <input type="hidden" name="locationProvider" value={value.provider} />
      <input type="hidden" name="locationPlaceId" value={value.placeId} />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <label htmlFor="venue-search" className="sr-only">Search for the venue</label>
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id="venue-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // don't submit the event form
                search();
              }
            }}
            placeholder="Venue, building or street, e.g. Carnivore, Langata Road"
            className="h-12 w-full rounded-2xl border border-line bg-white/5 pl-10 pr-4 text-[15px] placeholder:text-subtle focus:border-white/40 focus:outline-none"
            aria-describedby="venue-search-hint"
          />
        </div>
        <button
          type="button"
          onClick={search}
          disabled={searching}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-white/10 px-5 text-sm font-semibold hover:bg-white/15 disabled:opacity-60"
        >
          {searching ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
          Search
        </button>
      </div>
      <p id="venue-search-hint" className="text-xs text-subtle">
        Searches Kenyan places on OpenStreetMap. Can&apos;t find it? Click the map to drop the pin yourself.
      </p>

      {searchError && <p role="alert" className="text-sm text-warning">{searchError}</p>}
      {results && results.length === 0 && (
        <p role="status" className="text-sm text-muted">No matches. Try a nearby landmark or road, or place the pin on the map.</p>
      )}
      {results && results.length > 0 && (
        <ul role="listbox" aria-label="Search results" className="max-h-56 space-y-1.5 overflow-y-auto">
          {results.map((r) => {
            const active = r.id === selectedId;
            return (
              <li key={r.id} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => choose(r)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border p-3 text-left text-sm transition",
                    active ? "border-white/50 bg-white/[.08]" : "border-line hover:border-line-strong hover:bg-white/4",
                  )}
                >
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-medium">{r.name}</span>
                    <span className="block truncate text-xs text-muted">{r.displayName}</span>
                  </span>
                  {active && <CheckCircle2 className="ml-auto size-4 shrink-0 text-success" aria-label="Selected" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selected && (
        <button type="button" onClick={() => onPlaceSelected({ name: selected.name, address: selected.address, city: selected.city }, true)} className="text-xs text-fg/80 underline-offset-4 hover:underline">
          Replace venue name &amp; address fields with “{selected.name}”
        </button>
      )}

      <div className="tikiti-map relative isolate aspect-[4/3] overflow-hidden rounded-3xl border border-line bg-surface sm:aspect-[16/9]">
        <div ref={mapEl} className="absolute inset-0" aria-label="Venue location map. Click to place the pin, or pan with arrow keys and use “Set pin at map centre”." />
        {mapState === "loading" && <div className="skeleton absolute inset-0 z-[500]" aria-hidden />}
        {mapState === "ready" && (
          <Crosshair className="pointer-events-none absolute left-1/2 top-1/2 z-[450] size-5 -translate-x-1/2 -translate-y-1/2 text-white/60" aria-hidden />
        )}
        {mapState === "error" && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-surface p-4 text-center text-sm text-muted">
            The map couldn&apos;t load. Check your connection and reload — a confirmed pin is required to publish.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={mapState !== "ready"}
          onClick={() => {
            const c = mapRef.current?.getCenter();
            if (c) placePin({ lat: c.lat, lng: c.lng }, { provider: "manual" });
          }}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white/8 px-4 text-sm hover:bg-white/14 disabled:opacity-50"
        >
          <Crosshair className="size-4" aria-hidden /> Set pin at map centre
        </button>
        <button
          type="button"
          disabled={!value.pin || value.confirmed}
          onClick={() => setValue((v) => ({ ...v, confirmed: true }))}
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold transition disabled:cursor-default",
            value.confirmed ? "bg-success/15 text-success" : "bg-white text-black hover:bg-white/90 disabled:opacity-40",
          )}
        >
          <CheckCircle2 className="size-4" aria-hidden /> {value.confirmed ? "Pin confirmed" : "Confirm pin"}
        </button>
      </div>

      <div role="status" aria-live="polite" className="space-y-1 text-xs">
        {value.pin && isValidLatLng(value.pin.lat, value.pin.lng) ? (
          <p className="text-muted">
            Pin: <span className="font-mono text-fg/85">{formatCoords(value.pin)}</span>
            {value.confirmed ? " · confirmed" : " · drag the pin onto the entrance, then confirm"}
          </p>
        ) : (
          <p className="text-muted">No pin yet. Search for the venue or click the map.</p>
        )}
        {outsideKenya && (
          <p className="flex items-center gap-1.5 text-warning"><AlertTriangle className="size-3.5" aria-hidden /> This pin is outside Kenya — double-check the location.</p>
        )}
      </div>
      {error && <p id="location-error" role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
