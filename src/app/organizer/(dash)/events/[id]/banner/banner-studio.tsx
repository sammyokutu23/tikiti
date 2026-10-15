"use client";

import { useActionState, useMemo, useState } from "react";
import { Download, ImageIcon, Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { Alert, Badge, Card, Field, Select, Textarea, buttonClasses } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { cn } from "@/lib/utils";
import { generateBannerAction, saveBannerCoverAction } from "@/app/organizer/actions";

export type StudioGeneration = {
  id: string;
  status: "pending" | "succeeded" | "failed";
  createdAt: string;
  style: string;
  format: string;
  images: string[];
  errorMessage: string | null;
};

type Option = { value: string; label: string };

const OVERLAY_SWITCHES = [
  ["showText", "Event text"],
  ["showDate", "Date & time"],
  ["showVenue", "Venue"],
  ["showCta", "“Get tickets” button"],
  ["showOrganizer", "Organizer name"],
] as const;
type Overlay = Record<(typeof OVERLAY_SWITCHES)[number][0], boolean>;

export function BannerStudio(props: {
  eventId: string;
  title: string;
  category: string;
  hasCover: boolean;
  available: boolean;
  styles: Option[];
  formats: Option[];
  categories: Option[];
  maxCount: number;
  remainingToday: number;
  generations: StudioGeneration[];
}) {
  const [gen, generate, generating] = useActionState(generateBannerAction, {} as FormState);
  const [saveState, save, saving] = useActionState(saveBannerCoverAction, {} as FormState);
  const firstOk = props.generations.find((g) => g.status === "succeeded" && g.images.length > 0);
  const [picked, setPicked] = useState<{ g: string; i: number; nonce: number } | null>(firstOk ? { g: firstOk.id, i: 0, nonce: 0 } : null);
  const [format, setFormat] = useState("landscape");
  const [overlay, setOverlay] = useState<Overlay>({ showText: true, showDate: true, showVenue: true, showCta: false, showOrganizer: false });
  const [style, setStyle] = useState(gen.values?.style ?? props.styles[0].value);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const fe = gen.fieldErrors ?? {};

  // The newest concept is selected after each successful generation, until the organizer picks another.
  const genNonce = gen.ok && gen.values?.generationId ? (gen.nonce ?? 0) : 0;
  const selected = genNonce > (picked?.nonce ?? 0) ? { g: gen.values!.generationId, i: 0 } : picked;
  const setSelected = (s: { g: string; i: number }) => setPicked({ ...s, nonce: genNonce });

  const previewUrl = useMemo(() => {
    if (!selected) return null;
    const q = new URLSearchParams({ g: selected.g, i: String(selected.i), format });
    for (const [k] of OVERLAY_SWITCHES) q.set(k, overlay[k] ? "1" : "0");
    return `/api/organizer/events/${props.eventId}/banner?${q}`;
  }, [selected?.g, selected?.i, format, overlay, props.eventId]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewLoading = !!previewUrl && loadedUrl !== previewUrl;

  const disabled = !props.available || props.remainingToday <= 0;

  return (
    <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
      {/* ── Generate ── */}
      <form action={generate} className="space-y-5" noValidate>
        <input type="hidden" name="eventId" value={props.eventId} />
        {gen.error && <Alert tone="danger">{gen.error}</Alert>}
        {gen.ok && gen.message && <Alert tone="success">{gen.message} Pick one below to preview it with your event details.</Alert>}

        <Field label="Event title" htmlFor="title" hint="Added to the banner exactly as saved in Event details.">
          <p id="title" className="rounded-2xl border border-line bg-fg/4 px-4 py-3 text-sm font-medium">{props.title}</p>
        </Field>
        <Field label="Category" htmlFor="category" error={fe.category}>
          <Select id="category" name="category" defaultValue={gen.values?.category ?? props.category}>
            {props.categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Describe the vibe" htmlFor="brief" error={fe.brief} hint="Mood, setting, colours, crowd. Don't include the event name or dates — those are added for you.">
          <Textarea id="brief" name="brief" rows={4} maxLength={600} defaultValue={gen.values?.brief} placeholder="e.g. Sunset rooftop over the Nairobi skyline, warm amber lights, stylish crowd dancing to Afro-house" />
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Visual style</legend>
          <input type="hidden" name="style" value={style} />
          <div className="grid grid-cols-2 gap-2">
            {props.styles.map((s) => (
              <button
                type="button"
                key={s.value}
                onClick={() => setStyle(s.value)}
                aria-pressed={style === s.value}
                className={cn(
                  "rounded-2xl border px-3 py-2.5 text-left text-sm transition",
                  style === s.value ? "border-fg/60 bg-fg/10 font-semibold" : "border-line hover:border-line-strong",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          {fe.style && <p className="text-xs text-danger">{fe.style}</p>}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Shape" htmlFor="format" hint="Artwork is composed for this shape.">
            <Select id="format" name="format" defaultValue={gen.values?.format ?? "landscape"}>
              {props.formats.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
          </Field>
          <Field label="Concepts" htmlFor="count">
            <Select id="count" name="count" defaultValue={gen.values?.count ?? "1"}>
              {Array.from({ length: props.maxCount }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Refine (optional)" htmlFor="refinement" error={fe.refinement} hint="What should change from the last version?">
          <Textarea id="refinement" name="refinement" rows={2} maxLength={300} defaultValue={gen.values?.refinement} placeholder="e.g. less purple, more daylight, closer view of the stage" />
        </Field>

        <SubmitButton full size="lg" pending={generating} disabled={disabled} pendingLabel="Generating… up to a minute">
          <Sparkles className="size-5" aria-hidden /> Generate artwork
        </SubmitButton>
        <p className="text-center text-xs text-subtle">
          {props.available
            ? props.remainingToday > 0
              ? `${props.remainingToday} image${props.remainingToday === 1 ? "" : "s"} left in the next 24 hours. Each concept counts as one.`
              : "You've used today's AI images. You can still upload your own artwork."
            : "AI generation isn't available right now. You can still upload your own artwork in Event details."}
        </p>
      </form>

      {/* ── Results & preview ── */}
      <div className="min-w-0 space-y-6">
        {generating && (
          <Card className="flex items-center gap-3 p-4 text-sm" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden /> Creating your artwork. Keep this page open.
          </Card>
        )}

        {selected && previewUrl ? (
          <Card className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">Preview</h2>
              <div className="flex gap-1 rounded-full bg-fg/6 p-1" role="tablist" aria-label="Banner shape">
                {props.formats.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    role="tab"
                    aria-selected={format === f.value}
                    onClick={() => setFormat(f.value)}
                    className={cn("rounded-full px-3 py-1.5 text-xs font-medium", format === f.value ? "bg-primary text-primary-fg" : "text-fg/75 hover:text-fg")}
                  >
                    {f.label.split(" (")[0]}
                  </button>
                ))}
              </div>
            </div>
            <div className={cn("relative mx-auto overflow-hidden rounded-2xl bg-fg/6", format === "landscape" ? "aspect-video w-full" : format === "square" ? "aspect-square w-full max-w-md" : "aspect-[2/3] w-full max-w-sm")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={previewUrl} src={previewUrl} alt="Composed banner preview" className="size-full object-cover" onLoad={() => setLoadedUrl(previewUrl)} onError={() => setLoadedUrl(previewUrl)} />
              {previewLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30"><Loader2 className="size-7 animate-spin text-white" aria-hidden /></div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {OVERLAY_SWITCHES.map(([k, label]) => (
                <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs", overlay[k] ? "border-fg/50 bg-fg/8" : "border-line text-muted", k !== "showText" && !overlay.showText && "opacity-40")}>
                  <input type="checkbox" className="accent-current" checked={overlay[k]} disabled={k !== "showText" && !overlay.showText} onChange={(e) => setOverlay({ ...overlay, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={`${previewUrl}&download=1`} className={buttonClasses("secondary", "sm")}><Download className="size-4" aria-hidden /> Download this banner</a>
            </div>

            <form action={save} className="space-y-3 border-t border-line pt-4">
              <input type="hidden" name="eventId" value={props.eventId} />
              <input type="hidden" name="generationId" value={selected.g} />
              <input type="hidden" name="index" value={selected.i} />
              {OVERLAY_SWITCHES.map(([k]) => <input key={k} type="hidden" name={k} value={overlay[k] ? "1" : "0"} />)}
              {saveState.error && <Alert tone="danger">{saveState.error}</Alert>}
              <p className="text-sm text-muted">The event cover uses the 16:9 website banner{format !== "landscape" ? " (switch to Website banner to preview it)" : ""}. Text stays clear of the edges that cards crop.</p>
              {props.hasCover && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="confirmReplace" className="mt-0.5 size-4" />
                  <span>Replace the current cover. <span className="text-muted">The old image isn&apos;t deleted.</span></span>
                </label>
              )}
              <SubmitButton pending={saving} pendingLabel="Saving cover…"><ImageIcon className="size-4" aria-hidden /> Save as event cover</SubmitButton>
            </form>
          </Card>
        ) : (
          <Card className="flex flex-col items-center gap-3 p-10 text-center">
            <Wand2 className="size-8 text-muted" aria-hidden />
            <p className="font-semibold">No artwork yet</p>
            <p className="max-w-sm text-sm text-muted">Describe your event, pick a style and generate. You&apos;ll preview each concept with your real title, date and venue before saving anything.</p>
          </Card>
        )}

        {props.generations.length > 0 && (
          <section className="space-y-3" aria-labelledby="history-h">
            <h2 id="history-h" className="font-semibold">Your concepts</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {props.generations.flatMap((g) =>
                g.status === "succeeded"
                  ? g.images.map((src, i) => (
                      <button
                        key={`${g.id}-${i}`}
                        type="button"
                        onClick={() => setSelected({ g: g.id, i })}
                        aria-pressed={selected?.g === g.id && selected.i === i}
                        className={cn("group relative aspect-[3/2] overflow-hidden rounded-2xl border-2", selected?.g === g.id && selected.i === i ? "border-fg" : "border-transparent hover:border-line-strong")}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`Concept from ${new Date(g.createdAt).toLocaleString()}`} className="size-full object-cover" loading="lazy" />
                        <Badge className="absolute left-2 top-2 !bg-black/55 !text-white">{props.styles.find((s) => s.value === g.style)?.label ?? g.style}</Badge>
                      </button>
                    ))
                  : [
                      <div key={g.id} className="flex aspect-[3/2] flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-line p-3 text-center text-xs text-muted">
                        {g.status === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                        {g.status === "pending" ? "Generating…" : g.errorMessage ?? "Generation failed"}
                        {g.status === "failed" && <span className="text-subtle">Not counted toward your limit</span>}
                      </div>,
                    ],
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
