"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** In-page tabs for panels that sit side by side in one card (the URL-based Tabs switch whole pages). */
export function PanelTabs({ tabs }: { tabs: { key: string; label: ReactNode; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const id = useId();
  return (
    <div className="space-y-4">
      <div role="tablist" className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${id}-${t.key}-tab`}
            aria-selected={t.key === active}
            aria-controls={`${id}-${t.key}`}
            onClick={() => setActive(t.key)}
            className={cn(
              "whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition",
              t.key === active ? "bg-primary text-primary-fg" : "bg-fg/6 text-fg/80 hover:bg-fg/12",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        // Inactive panels stay mounted so half-filled forms survive switching tabs.
        <div key={t.key} role="tabpanel" id={`${id}-${t.key}`} aria-labelledby={`${id}-${t.key}-tab`} hidden={t.key !== active}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
