"use client";

import { useActionState } from "react";
import { Alert, Field, Input, Textarea } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { applyAction } from "../actions";

export function ApplyForm({ defaults }: { defaults: Record<string, string> }) {
  const [state, action, pending] = useActionState(applyAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = { ...defaults, ...state.values };
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="Organizer or brand name" htmlFor="displayName" error={fe.displayName} hint="Shown on your event pages.">
        <Input id="displayName" name="displayName" defaultValue={v.displayName} error={fe.displayName} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact email" htmlFor="contactEmail" error={fe.contactEmail}>
          <Input id="contactEmail" name="contactEmail" type="email" defaultValue={v.contactEmail} error={fe.contactEmail} />
        </Field>
        <Field label="Contact phone" htmlFor="contactPhone" error={fe.contactPhone}>
          <Input id="contactPhone" name="contactPhone" type="tel" defaultValue={v.contactPhone} error={fe.contactPhone} />
        </Field>
        <Field label="City" htmlFor="city" error={fe.city}>
          <Input id="city" name="city" defaultValue={v.city} placeholder="Nairobi" />
        </Field>
        <Field label="Website or social link" htmlFor="website" error={fe.website}>
          <Input id="website" name="website" type="url" defaultValue={v.website} placeholder="https://" error={fe.website} />
        </Field>
      </div>
      <Field label="About you" htmlFor="bio" hint="What kind of events do you run? Helps us verify you faster.">
        <Textarea id="bio" name="bio" defaultValue={v.bio} maxLength={1000} />
      </Field>
      <SubmitButton size="lg" pending={pending}>Submit application</SubmitButton>
    </form>
  );
}
