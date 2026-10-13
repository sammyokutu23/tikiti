"use client";

import { useActionState } from "react";
import { Alert, Field, Input, Select, Textarea } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { reportEventAction } from "./actions";

export function ReportForm({ eventId }: { eventId: string }) {
  const [state, action, pending] = useActionState(reportEventAction, {} as FormState);
  if (state.ok) return <Alert tone="success" title="Thanks for letting us know">{state.message}</Alert>;
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="eventId" value={eventId} />
      <Field label="Reason" htmlFor="reason" error={state.fieldErrors?.reason}>
        <Select id="reason" name="reason" defaultValue="">
          <option value="" disabled>Choose a reason</option>
          <option value="fraud">Looks fraudulent or a scam</option>
          <option value="misleading">Misleading information</option>
          <option value="inappropriate">Inappropriate or offensive content</option>
          <option value="cancelled">Event was cancelled or didn&apos;t happen</option>
          <option value="other">Something else</option>
        </Select>
      </Field>
      <Field label="Details" htmlFor="details">
        <Textarea id="details" name="details" maxLength={2000} placeholder="Tell us what happened" />
      </Field>
      <Field label="Your email (optional)" htmlFor="email" hint="So we can follow up.">
        <Input id="email" name="email" type="email" />
      </Field>
      <SubmitButton pending={pending}>Send report</SubmitButton>
    </form>
  );
}
