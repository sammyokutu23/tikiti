"use client";

import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClasses } from "./index";
import { cn } from "@/lib/utils";

/** Submit button that disables itself and shows a spinner while its form is pending. */
export function SubmitButton({
  children,
  pendingLabel,
  variant,
  size,
  full,
  className,
  pending: pendingProp,
  ...props
}: ComponentProps<"button"> & {
  pendingLabel?: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg";
  full?: boolean;
  pending?: boolean;
}) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  return (
    <button
      type="submit"
      disabled={pending || props.disabled}
      aria-busy={pending}
      className={cn(buttonClasses(variant, size, full), className)}
      {...props}
    >
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

/** A form button that asks for confirmation before submitting. */
export function ConfirmButton({ message, ...props }: ComponentProps<typeof SubmitButton> & { message: string }) {
  return (
    <SubmitButton
      {...props}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    />
  );
}
