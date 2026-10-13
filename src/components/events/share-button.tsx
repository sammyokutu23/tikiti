"use client";

import { Check, Share2 } from "lucide-react";
import { useState } from "react";

export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Share event"
      title="Share event"
      onClick={async () => {
        const url = window.location.href.split("?")[0];
        try {
          if (navigator.share) await navigator.share({ title, url });
          else {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        } catch {
          /* user dismissed */
        }
      }}
      className="glass inline-flex size-11 items-center justify-center rounded-full border border-white/10 text-white hover:bg-white/15"
    >
      {copied ? <Check className="size-5" aria-hidden /> : <Share2 className="size-5" aria-hidden />}
      <span className="sr-only" aria-live="polite">{copied ? "Link copied" : ""}</span>
    </button>
  );
}
