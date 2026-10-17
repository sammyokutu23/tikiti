"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { LEGACY_THEME_COOKIE, THEME_COOKIE, type Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** Applies a theme immediately and remembers it (cookie, so the server renders it next time). */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
  document.cookie = `${LEGACY_THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const Current = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${theme}. Change theme`}
        className="inline-flex size-9 items-center justify-center rounded-full text-fg/80 transition hover:bg-fg/8 hover:text-fg"
      >
        <Current className="size-[18px]" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Theme" className="absolute right-0 top-11 z-50 w-40 rounded-2xl border border-line bg-bg-elevated p-1.5 shadow-2xl">
          {OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === value}
              onClick={() => {
                applyTheme(value);
                setTheme(value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition",
                theme === value ? "bg-fg/8 text-fg" : "text-fg/80 hover:bg-fg/6 hover:text-fg",
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="flex-1">{label}</span>
              {theme === value && <Check className="size-4" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
