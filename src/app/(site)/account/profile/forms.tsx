"use client";

import { useActionState } from "react";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { updateProfileAction } from "../actions";

export function ProfileForm({ name, phone, email }: { name: string; phone: string; email: string }) {
  const [state, action, pending] = useActionState(updateProfileAction, {} as FormState);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message && <Alert tone="success">{state.message}</Alert>}
      <Field label="Email" htmlFor="email" hint="Manage your email, password and sign-in methods from the account menu (your avatar).">
        <Input id="email" value={email} disabled readOnly />
      </Field>
      <Field label="Full name" htmlFor="name" error={state.fieldErrors?.name}>
        <Input id="name" name="name" defaultValue={state.values?.name ?? name} error={state.fieldErrors?.name} />
      </Field>
      <Field label="Phone" htmlFor="phone" error={state.fieldErrors?.phone}>
        <Input id="phone" name="phone" type="tel" defaultValue={state.values?.phone ?? phone} error={state.fieldErrors?.phone} />
      </Field>
      <SubmitButton pending={pending}>Save profile</SubmitButton>
    </form>
  );
}
