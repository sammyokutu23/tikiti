"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Check, ImagePlus, Sparkles } from "lucide-react";
import { Alert, Field, Input, Select, Textarea, buttonClasses } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { eventImageSrc } from "@/lib/images";
import { LocationPicker, type PickedPlace } from "@/components/maps/location-picker";
import { TICKET_PRESETS } from "@/lib/ticket-presets";
import { cn } from "@/lib/utils";
import { addPresetTicketTypesAction, saveEventAction, saveTicketTypeAction } from "./actions";

const CATEGORIES = [
  ["music", "Music"],
  ["festival", "Festival"],
  ["nightlife", "Nightlife"],
  ["conference", "Conference"],
  ["sports", "Sports"],
  ["workshop", "Workshop"],
  ["comedy", "Comedy"],
  ["arts", "Arts & Culture"],
];

export type EventFormDefaults = Partial<Record<"title" | "summary" | "description" | "category" | "venueName" | "venueAddress" | "city" | "timezone" | "startsLocal" | "endsLocal" | "refundPolicy" | "coverImageUrl" | "arrivalInstructions" | "latitude" | "longitude" | "locationProvider" | "locationPlaceId" | "locationConfirmed" | "installmentsEnabled", string>>;

export function EventForm({ eventId, defaults }: { eventId?: string; defaults: EventFormDefaults }) {
  const [state, action, pending] = useActionState(saveEventAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = { ...defaults, ...state.values } as EventFormDefaults;
  const [preview, setPreview] = useState<string | null>(eventImageSrc(v.coverImageUrl, 800));
  const [fileError, setFileError] = useState<string | null>(null);
  // Venue fields are controlled so a selected search result can fill them in.
  const [venue, setVenue] = useState({ venueName: v.venueName ?? "", venueAddress: v.venueAddress ?? "", city: v.city ?? "" });
  const fillFromPlace = (p: PickedPlace, overwrite: boolean) =>
    // Never overwrite what the organizer typed with a partial geocoding result unless they ask to.
    setVenue((cur) => ({
      venueName: overwrite || !cur.venueName ? p.name || cur.venueName : cur.venueName,
      venueAddress: overwrite || !cur.venueAddress ? p.address || cur.venueAddress : cur.venueAddress,
      city: overwrite || !cur.city ? p.city || cur.city : cur.city,
    }));
  const lat = Number(v.latitude);
  const lng = Number(v.longitude);
  const hasPin = !!v.latitude && !!v.longitude && Number.isFinite(lat) && Number.isFinite(lng);

  return (
    <form action={action} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {Object.keys(fe).length > 0 && <Alert tone="danger">Please fix the highlighted fields.</Alert>}
      <input type="hidden" name="eventId" value={eventId ?? ""} />
      <input type="hidden" name="coverImageUrl" value={v.coverImageUrl ?? ""} />

      <div className="space-y-2">
        <p className="text-sm font-medium">Cover image</p>
        <label className="group relative flex aspect-[16/7] cursor-pointer items-center justify-center overflow-hidden rounded-3xl border border-dashed border-line-strong bg-fg/4 hover:bg-fg/6">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Cover preview" className="absolute inset-0 size-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-2 text-sm text-muted"><ImagePlus className="size-7" aria-hidden />Upload a JPG, PNG or WebP (max 4 MB)</span>
          )}
          <input
            type="file"
            name="coverImage"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setFileError(null);
              if (!f) return;
              if (f.size > 4 * 1024 * 1024) {
                setFileError("Image is too large. Maximum size is 4 MB.");
                e.target.value = "";
                return;
              }
              setPreview(URL.createObjectURL(f));
            }}
          />
          {preview && <span className="glass absolute bottom-3 right-3 rounded-full px-3 py-1 text-xs text-white">Change image</span>}
        </label>
        {(fileError || fe.coverImage) && <p className="text-xs text-danger">{fileError ?? fe.coverImage}</p>}
        <div className="flex flex-col gap-2 rounded-3xl border border-line bg-fg/4 p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">No artwork? Generate a professional banner with your event details.</p>
          {eventId ? (
            <Link href={`/organizer/events/${eventId}/banner`} className={buttonClasses("primary", "md")}>
              <Sparkles className="size-4" aria-hidden /> Create with AI
            </Link>
          ) : (
            // A new event must exist first: this saves the draft, then opens the AI Banner Studio.
            <button type="submit" name="intent" value="ai-banner" disabled={pending} className={buttonClasses("primary", "md")}>
              <Sparkles className="size-4" aria-hidden /> Save draft &amp; create with AI
            </button>
          )}
        </div>
      </div>

      <Field label="Event title" htmlFor="title" error={fe.title}>
        <Input id="title" name="title" defaultValue={v.title} error={fe.title} maxLength={120} />
      </Field>
      <Field label="Short summary" htmlFor="summary" error={fe.summary} hint="One line shown in search results.">
        <Input id="summary" name="summary" defaultValue={v.summary} maxLength={200} />
      </Field>
      <Field label="Description" htmlFor="description" error={fe.description}>
        <Textarea id="description" name="description" rows={7} defaultValue={v.description} error={fe.description} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" htmlFor="category" error={fe.category}>
          <Select key={`cat-${v.category ?? ""}`} id="category" name="category" defaultValue={v.category ?? ""} error={fe.category}>
            <option value="" disabled>Choose…</option>
            {CATEGORIES.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Time zone" htmlFor="timezone" error={fe.timezone} hint="Times below are in this zone.">
          <Select key={`tz-${v.timezone ?? ""}`} id="timezone" name="timezone" defaultValue={v.timezone ?? "Africa/Nairobi"}>
            <option value="Africa/Nairobi">East Africa Time (Nairobi)</option>
            <option value="Africa/Kampala">Kampala</option>
            <option value="Africa/Dar_es_Salaam">Dar es Salaam</option>
            <option value="Africa/Kigali">Kigali</option>
          </Select>
        </Field>
        <Field label="Starts" htmlFor="startsLocal" error={fe.startsLocal}>
          <Input id="startsLocal" name="startsLocal" type="datetime-local" defaultValue={v.startsLocal} error={fe.startsLocal} />
        </Field>
        <Field label="Ends" htmlFor="endsLocal" error={fe.endsLocal}>
          <Input id="endsLocal" name="endsLocal" type="datetime-local" defaultValue={v.endsLocal} error={fe.endsLocal} />
        </Field>
      </div>

      <fieldset className="min-w-0 space-y-4 rounded-3xl border border-line p-4 sm:p-5" aria-describedby={fe.location ? "location-error" : undefined}>
        <legend className="px-1 text-sm font-semibold">Venue &amp; location</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Venue name" htmlFor="venueName" error={fe.venueName}>
            <Input id="venueName" name="venueName" value={venue.venueName} onChange={(e) => setVenue({ ...venue, venueName: e.target.value })} error={fe.venueName} />
          </Field>
          <Field label="City / town" htmlFor="city" error={fe.city}>
            <Input id="city" name="city" value={venue.city} onChange={(e) => setVenue({ ...venue, city: e.target.value })} list="ke-cities" error={fe.city} />
            <datalist id="ke-cities">
              {["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret", "Naivasha", "Diani", "Malindi", "Thika", "Nanyuki"].map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
        </div>
        <Field label="Address / directions in words" htmlFor="venueAddress" error={fe.venueAddress} hint="Kenyan addresses are often landmark-based, e.g. “Langata Road, opposite Wilson Airport” or “Off Ngong Road, next to …”.">
          <Input id="venueAddress" name="venueAddress" value={venue.venueAddress} onChange={(e) => setVenue({ ...venue, venueAddress: e.target.value })} />
        </Field>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Map pin</p>
          <LocationPicker
            initialQuery={v.venueName ? [v.venueName, v.city].filter(Boolean).join(", ") : ""}
            error={fe.location}
            onPlaceSelected={fillFromPlace}
            initial={{
              pin: hasPin ? { lat, lng } : null,
              confirmed: hasPin && v.locationConfirmed === "1",
              provider: v.locationProvider === "nominatim" ? "nominatim" : "manual",
              placeId: v.locationPlaceId ?? "",
            }}
          />
        </div>
        <Field label="Entrance & arrival instructions (optional)" htmlFor="arrivalInstructions" error={fe.arrivalInstructions} hint="Shown on the event page, tickets and confirmation email. e.g. “Use Gate B on Magadi Road; parking KES 200.”">
          <Textarea id="arrivalInstructions" name="arrivalInstructions" rows={2} maxLength={500} defaultValue={v.arrivalInstructions} error={fe.arrivalInstructions} />
        </Field>
      </fieldset>
      <Field label="Refund & cancellation policy" htmlFor="refundPolicy" error={fe.refundPolicy} hint="Shown to buyers before they pay.">
        <Textarea id="refundPolicy" name="refundPolicy" rows={3} defaultValue={v.refundPolicy} error={fe.refundPolicy} />
      </Field>
      <Field label="Lipa Mdogo Mdogo" htmlFor="installmentsEnabled" hint="Buyers pay a deposit and the rest in M-Pesa installments. Tickets are issued only after full payment; unpaid plans release their tickets before the event. Turning this off doesn't affect existing plans.">
        <label className="flex items-center gap-3 rounded-2xl border border-line px-4 py-3 text-sm">
          <input id="installmentsEnabled" type="checkbox" name="installmentsEnabled" defaultChecked={v.installmentsEnabled === "on"} className="size-5" />
          Offer installment payment plans for this event
        </label>
      </Field>
      <SubmitButton size="lg" pending={pending} pendingLabel="Saving…">{eventId ? "Save changes" : "Create draft"}</SubmitButton>
    </form>
  );
}

export function TicketTypeForm({
  eventId,
  ticketTypeId,
  defaults = {},
  submitLabel,
}: {
  eventId: string;
  ticketTypeId?: string;
  defaults?: Record<string, string>;
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState(saveTicketTypeAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = { ...defaults, ...(state.ok ? {} : state.values) };
  const id = (k: string) => `${ticketTypeId ?? "new"}-${k}`;
  return (
    <form action={action} className="space-y-4" noValidate key={ticketTypeId ? undefined : state.nonce}>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.ok && <Alert tone="success">{state.message}</Alert>}
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="ticketTypeId" value={ticketTypeId ?? ""} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={id("name")} error={fe.name} hint="e.g. Early Bird, Regular, VIP">
          <Input id={id("name")} name="name" defaultValue={v.name} error={fe.name} />
        </Field>
        <Field label="Price (KES)" htmlFor={id("price")} error={fe.price} hint="Use 0 for free tickets.">
          <Input id={id("price")} name="price" inputMode="decimal" defaultValue={v.price} error={fe.price} />
        </Field>
        <Field label="Quantity available" htmlFor={id("capacity")} error={fe.capacity}>
          <Input id={id("capacity")} name="capacity" type="number" min={1} defaultValue={v.capacity} error={fe.capacity} />
        </Field>
        <Field label="Max per order" htmlFor={id("maxPerOrder")} error={fe.maxPerOrder}>
          <Input id={id("maxPerOrder")} name="maxPerOrder" type="number" min={1} max={50} defaultValue={v.maxPerOrder ?? "10"} />
        </Field>
        <Field label="Sales start (optional)" htmlFor={id("salesStartLocal")} error={fe.salesStartLocal}>
          <Input id={id("salesStartLocal")} name="salesStartLocal" type="datetime-local" defaultValue={v.salesStartLocal} />
        </Field>
        <Field label="Sales end (optional)" htmlFor={id("salesEndLocal")} error={fe.salesEndLocal}>
          <Input id={id("salesEndLocal")} name="salesEndLocal" type="datetime-local" defaultValue={v.salesEndLocal} error={fe.salesEndLocal} />
        </Field>
      </div>
      <Field label="Description (optional)" htmlFor={id("description")}>
        <Input id={id("description")} name="description" defaultValue={v.description} maxLength={300} />
      </Field>
      <SubmitButton variant={ticketTypeId ? "secondary" : "primary"} pending={pending}>{submitLabel}</SubmitButton>
    </form>
  );
}

/** Quick add: tick common ticket types and enter just a price (quantity is prefilled). */
export function QuickTicketTypes({ eventId, existingNames }: { eventId: string; existingNames: string[] }) {
  const [state, action, pending] = useActionState(addPresetTicketTypesAction, {} as FormState);
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const presets = TICKET_PRESETS.filter((p) => !taken.has(p.name.toLowerCase()));
  if (!presets.length) return <p className="text-sm text-muted">All the common ticket types are already on this event. Use a custom ticket type below to add more.</p>;
  return <QuickTicketTypesForm key={state.nonce ?? 0} eventId={eventId} presets={presets} state={state} action={action} pending={pending} />;
}

function QuickTicketTypesForm({
  eventId,
  presets,
  state,
  action,
  pending,
}: {
  eventId: string;
  presets: (typeof TICKET_PRESETS)[number][];
  state: FormState;
  action: (fd: FormData) => void;
  pending: boolean;
}) {
  const v = state.ok ? {} : (state.values ?? {});
  const fe = state.fieldErrors ?? {};
  const [checked, setChecked] = useState<Set<string>>(() => new Set(presets.filter((p) => v[`${p.key}_on`] === "on").map((p) => p.key)));
  const toggle = (key: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.ok && <Alert tone="success">{state.message}</Alert>}
      <input type="hidden" name="eventId" value={eventId} />
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {presets.map((p) => {
          const on = checked.has(p.key);
          const free = "free" in p;
          const id = (k: string) => `preset-${p.key}-${k}`;
          const err = fe[`${p.key}_price`] ?? fe[`${p.key}_capacity`];
          return (
            <li key={p.key} className={cn("p-3 sm:p-4", on && "bg-fg/[0.03]")}>
              <div className="flex flex-wrap items-center gap-3">
                {/* A button, not a checkbox: React resets the form after submit, which would untick a native checkbox. */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(p.key, !on)}
                  className="flex min-w-40 flex-1 items-start gap-3 text-left"
                >
                  <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border", on ? "border-primary bg-primary text-primary-fg" : "border-line-strong")}>
                    {on && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
                  </span>
                  <span>
                    <span className="block font-semibold">{p.name}</span>
                    {p.description && <span className="block text-xs text-muted">{p.description}</span>}
                  </span>
                </button>
                {on && <input type="hidden" name={`${p.key}_on`} value="on" />}
                {on && (
                  <div className="flex w-full gap-2 sm:w-auto">
                    {free ? (
                      <div className="w-full sm:w-36">
                        <span className="mb-1 block text-[11px] text-muted">Price (KES)</span>
                        <span className="flex h-11 items-center rounded-xl border border-line px-3 text-sm text-muted">Free · KES 0</span>
                      </div>
                    ) : (
                      <div className="w-full sm:w-36">
                        <label htmlFor={id("price")} className="mb-1 block text-[11px] text-muted">Price (KES)</label>
                        <Input
                          id={id("price")}
                          name={`${p.key}_price`}
                          inputMode="numeric"
                          placeholder="e.g. 1500"
                          defaultValue={v[`${p.key}_price`]}
                          error={fe[`${p.key}_price`]}
                          autoFocus={!v[`${p.key}_price`]}
                        />
                      </div>
                    )}
                    <div className="w-full sm:w-28">
                      <label htmlFor={id("capacity")} className="mb-1 block text-[11px] text-muted">Quantity</label>
                      <Input
                        id={id("capacity")}
                        name={`${p.key}_capacity`}
                        type="number"
                        min={1}
                        title="Quantity available"
                        defaultValue={v[`${p.key}_capacity`] || String(p.capacity)}
                        error={fe[`${p.key}_capacity`]}
                      />
                    </div>
                  </div>
                )}
              </div>
              {on && err && <p className="mt-2 text-xs text-danger">{err}</p>}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-subtle">Enter the price and how many tickets are available (prefilled, change it if needed). Up to 10 per order. You can edit names, sale dates and limits after adding.</p>
      <SubmitButton pending={pending} disabled={!checked.size}>
        {checked.size > 1 ? `Add ${checked.size} ticket types` : "Add ticket type"}
      </SubmitButton>
    </form>
  );
}
