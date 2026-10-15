"use client";

import { useActionState, useState } from "react";
import { ImagePlus } from "lucide-react";
import { Alert, Field, Input, Select, Textarea } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { eventImageSrc } from "@/lib/images";
import { LocationPicker, type PickedPlace } from "@/components/maps/location-picker";
import { saveEventAction, saveTicketTypeAction } from "./actions";

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

export type EventFormDefaults = Partial<Record<"title" | "summary" | "description" | "category" | "venueName" | "venueAddress" | "city" | "timezone" | "startsLocal" | "endsLocal" | "refundPolicy" | "coverImageUrl" | "arrivalInstructions" | "latitude" | "longitude" | "locationProvider" | "locationPlaceId" | "locationConfirmed", string>>;

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
            <span className="flex flex-col items-center gap-2 text-sm text-muted"><ImagePlus className="size-7" aria-hidden />Upload a JPG, PNG or WebP (max 5 MB)</span>
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
              if (f.size > 5 * 1024 * 1024) {
                setFileError("Image is too large. Maximum size is 5 MB.");
                e.target.value = "";
                return;
              }
              setPreview(URL.createObjectURL(f));
            }}
          />
          {preview && <span className="glass absolute bottom-3 right-3 rounded-full px-3 py-1 text-xs text-white">Change image</span>}
        </label>
        {(fileError || fe.coverImage) && <p className="text-xs text-danger">{fileError ?? fe.coverImage}</p>}
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
