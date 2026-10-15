import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Buttons ────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

export function buttonClasses(variant: Variant = "primary", size: Size = "md", full = false) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition select-none",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
    size === "sm" && "h-9 px-4 text-sm",
    size === "md" && "h-11 px-5 text-sm",
    size === "lg" && "h-14 px-7 text-base",
    variant === "primary" && "bg-primary text-primary-fg hover:bg-primary/90 active:scale-[.98]",
    variant === "secondary" && "bg-fg/8 text-fg hover:bg-fg/14 border border-line",
    variant === "outline" && "border border-line-strong text-fg hover:bg-fg/6",
    variant === "ghost" && "text-fg hover:bg-fg/8",
    variant === "danger" && "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
    full && "w-full",
  );
}

export function Button({
  variant,
  size,
  full,
  className,
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size; full?: boolean }) {
  return <button className={cn(buttonClasses(variant, size, full), className)} {...props} />;
}

export function ButtonLink({
  variant,
  size,
  full,
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size; full?: boolean }) {
  return <Link className={cn(buttonClasses(variant, size, full), className)} {...props} />;
}

export function IconButton({ className, label, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-full bg-fg/8 text-fg transition hover:bg-fg/14",
        className,
      )}
      {...props}
    />
  );
}

export function IconLink({ className, label, ...props }: ComponentProps<typeof Link> & { label: string }) {
  return (
    <Link
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-fg/8 text-fg transition hover:bg-fg/14",
        className,
      )}
      {...props}
    />
  );
}

// ─── Surfaces ───────────────────────────────────────────────────────────────

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-3xl border border-line bg-surface/80", className)} {...props} />;
}

export function Section({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        {back}
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <Card className={cn("p-4 sm:p-5", className)}>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1.5 text-xl font-bold tracking-tight tabular-nums sm:text-2xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </Card>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-fg/6 text-muted">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-2xl border p-4 text-sm",
        tone === "info" && "border-info/25 bg-info/8 text-info",
        tone === "success" && "border-success/25 bg-success/8 text-success",
        tone === "warning" && "border-warning/25 bg-warning/8 text-warning",
        tone === "danger" && "border-danger/25 bg-danger/8 text-danger",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-fg/80">{children}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-2xl", className)} aria-hidden />;
}

// ─── Badges ─────────────────────────────────────────────────────────────────

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "solid";

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-fg/8 text-fg/80",
        tone === "success" && "bg-success/12 text-success",
        tone === "warning" && "bg-warning/12 text-warning",
        tone === "danger" && "bg-danger/12 text-danger",
        tone === "info" && "bg-info/12 text-info",
        tone === "solid" && "bg-primary text-primary-fg",
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS: Record<string, [string, Tone]> = {
  // bookings
  pending: ["Pending", "warning"],
  confirmed: ["Confirmed", "success"],
  expired: ["Expired", "neutral"],
  cancelled: ["Cancelled", "neutral"],
  failed: ["Failed", "danger"],
  refunded: ["Refunded", "info"],
  // payments
  unpaid: ["Unpaid", "neutral"],
  paid: ["Paid", "success"],
  refund_pending: ["Refund pending", "warning"],
  not_required: ["Free", "neutral"],
  created: ["Created", "neutral"],
  succeeded: ["Succeeded", "success"],
  reconciliation_required: ["Needs review", "danger"],
  manual_required: ["Manual reversal", "danger"],
  // tickets
  valid: ["Valid", "success"],
  checked_in: ["Checked in", "info"],
  revoked: ["Revoked", "danger"],
  // events
  draft: ["Draft", "neutral"],
  published: ["Published", "success"],
  // organizers
  verified: ["Verified", "success"],
  rejected: ["Rejected", "danger"],
  suspended: ["Suspended", "danger"],
  // email
  queued: ["Queued", "warning"],
  sending: ["Sending", "warning"],
  sent: ["Sent", "success"],
  captured: ["Captured (dev)", "info"],
  delivered: ["Delivered", "success"],
  delivery_delayed: ["Delayed", "warning"],
  bounced: ["Bounced", "danger"],
  complained: ["Spam complaint", "danger"],
  suppressed: ["Suppressed", "danger"],
  retry_pending: ["Retrying", "warning"],
  skipped: ["Not needed", "neutral"],
  // jobs
  running: ["Running", "warning"],
  // scans
  accepted: ["Accepted", "success"],
  already_checked_in: ["Already in", "warning"],
  invalid: ["Invalid", "danger"],
  wrong_event: ["Wrong event", "danger"],
  not_confirmed: ["Not confirmed", "danger"],
  open: ["Open", "warning"],
  resolved: ["Resolved", "success"],
  dismissed: ["Dismissed", "neutral"],
  active: ["Active", "success"],
  // payment plans (Lipa Mdogo Mdogo)
  on_plan: ["Payment plan", "info"],
  partially_paid: ["Partly paid", "info"],
  awaiting_deposit: ["Awaiting deposit", "warning"],
  fully_paid: ["Fully paid", "success"],
  scheduled: ["Upcoming", "neutral"],
  due: ["Due", "warning"],
  payment_pending: ["Processing", "warning"],
  overdue: ["Overdue", "danger"],
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const [label, tone] = STATUS[status] ?? [status.replace(/_/g, " "), "neutral" as Tone];
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

// ─── Form fields ────────────────────────────────────────────────────────────

export const inputClasses =
  "w-full rounded-2xl border border-line bg-fg/5 px-4 py-3 text-[15px] text-fg placeholder:text-subtle transition focus:border-fg/40 focus:bg-fg/8 focus:outline-none aria-[invalid=true]:border-danger/60";

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg/90">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, error, ...props }: ComponentProps<"input"> & { error?: string }) {
  return (
    <input
      className={cn(inputClasses, className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={error && props.id ? `${props.id}-error` : undefined}
      {...props}
    />
  );
}

export function Textarea({ className, error, ...props }: ComponentProps<"textarea"> & { error?: string }) {
  return (
    <textarea
      className={cn(inputClasses, "min-h-28 resize-y", className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={error && props.id ? `${props.id}-error` : undefined}
      {...props}
    />
  );
}

export function Select({ className, error, ...props }: ComponentProps<"select"> & { error?: string }) {
  return (
    <select
      className={cn(inputClasses, "appearance-none bg-[length:16px] pr-10", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1a8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 1rem center",
      }}
      aria-invalid={error ? true : undefined}
      {...props}
    />
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-3xl border border-line bg-surface/60", className)}>
      <table className="w-full min-w-[640px] text-left text-sm [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted [&_thead]:border-b [&_thead]:border-line [&_tbody_tr]:border-b [&_tbody_tr]:border-line/60 [&_tbody_tr:last-child]:border-0 [&_tbody_tr:hover]:bg-fg/[.02]">
        {children}
      </table>
    </div>
  );
}

export function Tabs({ items, active }: { items: { href: string; label: ReactNode; key: string }[]; active: string }) {
  return (
    <nav className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="Sections">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          aria-current={it.key === active ? "page" : undefined}
          className={cn(
            "whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition",
            it.key === active ? "bg-primary text-primary-fg" : "bg-fg/6 text-fg/80 hover:bg-fg/12",
          )}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
