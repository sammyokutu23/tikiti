"use client";

import { useEffect, useRef, useState } from "react";
import { MapPinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { addTiles, loadLeaflet, pinIcon } from "./leaflet";

/**
 * Read-only venue map for the public event page. Lazy: Leaflet and tiles load
 * only when the map scrolls into view. Scroll-wheel zoom is off so the page
 * scrolls normally; zoom buttons, pinch, drag and keyboard (+/−/arrows) work.
 */
export function VenueMap({ lat, lng, label, className }: { lat: number; lng: number; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let map: import("leaflet").Map | null = null;
    let cancelled = false;
    const init = async () => {
      setState("loading");
      try {
        const L = await loadLeaflet();
        if (cancelled || !ref.current) return;
        map = L.map(ref.current, { scrollWheelZoom: false, zoomControl: true, keyboard: true }).setView([lat, lng], 16);
        addTiles(L, map, () => setState("error"));
        L.marker([lat, lng], { icon: pinIcon(L), keyboard: true, title: label, alt: label }).addTo(map).bindPopup(label.replace(/[<>&]/g, ""));
        map.getContainer().setAttribute("aria-label", `Map showing ${label}`);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          init();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      map?.remove();
    };
  }, [lat, lng, label]);

  return (
    <div className={cn("tikiti-map relative isolate overflow-hidden rounded-3xl border border-line bg-surface", className)}>
      <div ref={ref} className="absolute inset-0" role="region" aria-label={`Map: ${label}`} />
      {state !== "ready" && state !== "error" && <div className="skeleton absolute inset-0" aria-hidden />}
      {state === "error" && (
        <div className="absolute inset-0 z-[500] flex flex-col items-center justify-center gap-2 bg-surface p-4 text-center text-sm text-muted">
          <MapPinOff className="size-6" aria-hidden />
          <p>The map couldn&apos;t load. Use Get directions to open the venue in Google Maps.</p>
        </div>
      )}
    </div>
  );
}
