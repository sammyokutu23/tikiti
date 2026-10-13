"use client";

import { useActionState } from "react";
import { Mail } from "lucide-react";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { findBookingAction, resendTicketsAction } from "./actions";

export function ResendTicketsForm({ reference, access }: { reference: string; access: string | null }) {
  const [state, action, pending] = useActionState(resendTicketsAction, {} as FormState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="access" value={access ?? ""} />
      <SubmitButton variant="secondary" full pending={pending} pendingLabel="Queuing…">
        <Mail className="size-4" aria-hidden /> Email my tickets again
      </SubmitButton>
      {state.message && <p className="text-xs text-success" role="status">{state.message}</p>}
      {state.error && <p className="text-xs text-danger" role="alert">{state.error}</p>}
    </form>
  );
}

export function FindBookingForm() {
  const [state, action, pending] = useActionState(findBookingAction, {} as FormState);
  if (state.ok) return <Alert tone="success" title="Check your email">{state.message}</Alert>;
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="Email used for the booking" htmlFor="email" error={state.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" defaultValue={state.values?.email} error={state.fieldErrors?.email} />
      </Field>
      <Field label="Booking reference" htmlFor="reference" error={state.fieldErrors?.reference} hint="From your confirmation email, e.g. TK-7KQ2-9XHM">
        <Input id="reference" name="reference" autoCapitalize="characters" defaultValue={state.values?.reference} error={state.fieldErrors?.reference} className="font-mono uppercase" />
      </Field>
      <SubmitButton full size="lg" pending={pending}>Email me a secure link</SubmitButton>
    </form>
  );
}
