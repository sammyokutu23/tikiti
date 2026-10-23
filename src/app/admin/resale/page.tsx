import { CircleAlert, CircleCheck, FileText, LoaderCircle, TriangleAlert } from "lucide-react";
import { Flash } from "@/components/dash/flash";
import { PanelTabs } from "@/components/dash/panel-tabs";
import { LISTING_STATUS, ResaleTrustBadge } from "@/components/resale/listing-card";
import { Badge, Card, EmptyState, Field, Input, PageHeader, Section, Select, Table, Tabs, Textarea } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime, utcToZonedLocal } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { requireAdmin } from "@/server/auth/guards";
import { CATEGORIES } from "@/server/events/queries";
import { adminListings, linkableEvents, listingDocumentHistory, withdrawnDetails, type ListingDetails } from "@/server/resale/listings";
import type { CheckResult } from "@/server/resale/verify";
import { adminPayouts } from "@/server/resale/payouts";
import {
  adminWithdrawResaleAction,
  approveResaleAction,
  makeResaleBannerAction,
  markResalePayoutPaidAction,
  rejectResaleAction,
  replaceResaleDetailsAction,
  replaceResaleTicketFileAction,
  rerunResaleChecksAction,
  resolveResaleDisputeAction,
} from "../actions";

export const metadata = { title: "Resale" };

export default async function AdminResalePage({ searchParams }: PageProps<"/admin/resale">) {
  await requireAdmin();
  const sp = await searchParams;
  const tab = sp.tab === "active" || sp.tab === "all" || sp.tab === "payouts" ? sp.tab : "review";
  const payoutTab = sp.p === "held" || sp.p === "disputed" || sp.p === "paid" ? sp.p : "ready";
  const back = `/admin/resale${tab === "review" ? "" : `?tab=${tab}`}${tab === "payouts" && payoutTab !== "ready" ? `&p=${payoutTab}` : ""}`;

  return (
    <div className="space-y-8">
      <PageHeader title="Resale" subtitle="Review uploaded tickets, correct their details, list or reject them, settle disputes and record seller payouts." />
      <Flash sp={sp} />
      <Tabs
        active={tab}
        items={[
          { key: "review", label: "Uploaded tickets", href: "/admin/resale" },
          { key: "active", label: "For sale", href: "/admin/resale?tab=active" },
          { key: "all", label: "History", href: "/admin/resale?tab=all" },
          { key: "payouts", label: "Payouts & disputes", href: "/admin/resale?tab=payouts" },
        ]}
      />
      {tab === "review" && <ReviewQueue back={back} />}
      {(tab === "active" || tab === "all") && <ListingTable tab={tab} back={back} />}
      {tab === "payouts" && <Payouts tab={payoutTab} back={back} />}
    </div>
  );
}

function DetailsList({ d }: { d: ListingDetails }) {
  const rows: [string, string | null][] = [
    ["Event", d.eventName],
    ["Venue", [d.venue, d.city].filter(Boolean).join(", ") || null],
    ["Date", d.startsAt ? formatDateTime(new Date(d.startsAt)) : null],
    ["Ticket type", d.ticketTypeName],
    ["Bought on", d.platform],
    ["Order number", d.orderRef],
    ["M-Pesa code", d.mpesaCode ?? null],
    ["Note", d.note],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="font-medium">{v || <span className="font-normal text-subtle">Not given</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The verification bot's verdict. Advisory: only the admin's own Approve lists a ticket. */
function ChecksPanel({ listingId, status, result, checkedAt, back }: { listingId: string; status: string | null; result: CheckResult | null; checkedAt: Date | null; back: string }) {
  const head =
    status === "passed"
      ? { tone: "border-success/40 bg-success/10", icon: <CircleCheck className="size-5 shrink-0 text-success" aria-hidden />, title: "Checks passed: ready for your approval", body: "Everything the bot could check matches. Approving is still your decision." }
      : status === "flagged"
        ? { tone: "border-danger/40 bg-danger/10", icon: <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden />, title: "Problems found: check before approving", body: "Compare each item marked below with the uploaded files." }
        : status === "error"
          ? { tone: "border-warning/40 bg-warning/10", icon: <CircleAlert className="size-5 shrink-0 text-warning" aria-hidden />, title: "The checks couldn't run", body: "Review this ticket by hand, or run the checks again." }
          : status === "pending"
            ? { tone: "border-line bg-surface-2", icon: <LoaderCircle className="size-5 shrink-0 animate-spin text-muted" aria-hidden />, title: "Checking this ticket…", body: "The bot is reading the ticket and proof of purchase. Reload in a minute." }
            : { tone: "border-line bg-surface-2", icon: <CircleAlert className="size-5 shrink-0 text-muted" aria-hidden />, title: "Not checked yet", body: "This ticket was uploaded before the checks existed." };
  return (
    <div className={`space-y-3 rounded-2xl border p-4 ${head.tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-2.5">
          {head.icon}
          <div>
            <p className="font-semibold">{head.title}</p>
            <p className="text-sm text-muted">{head.body}{checkedAt && status !== "pending" ? ` Checked ${formatDateTime(checkedAt)}.` : ""}</p>
          </div>
        </div>
        <form action={rerunResaleChecksAction}>
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="back" value={back} />
          <SubmitButton size="sm" variant="ghost">Run checks again</SubmitButton>
        </form>
      </div>
      {result && result.items.length > 0 && status !== "pending" && (
        <ul className="space-y-1.5 text-sm">
          {result.items.map((it, i) => (
            <li key={i} className="flex gap-2">
              {it.status === "ok" ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Matches" />
              ) : it.status === "fail" ? (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Problem" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Check by hand" />
              )}
              <span><b className="font-medium">{it.label}:</b> {it.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function ReviewQueue({ back }: { back: string }) {
  const [rows, events] = await Promise.all([adminListings("review"), linkableEvents()]);
  if (rows.length === 0) return <EmptyState title="No uploaded tickets to review" body="Tickets sellers upload from other platforms appear here." />;
  return (
    <div className="space-y-5">
      {await Promise.all(
        rows.map(async ({ listing: l, sellerName, sellerEmail }) => {
          const [docs, withdrawn] = await Promise.all([listingDocumentHistory(l.id), withdrawnDetails(l.id)]);
          const start = l.externalStartsAt ?? new Date();
          const current: ListingDetails = {
            eventName: l.externalEventName,
            venue: l.externalVenue,
            city: l.externalCity,
            startsAt: l.externalStartsAt?.toISOString() ?? null,
            ticketTypeName: l.ticketTypeName,
            platform: l.externalPlatform,
            orderRef: l.externalOrderRef,
            mpesaCode: l.externalMpesaCode,
            note: l.sellerNote,
          };
          return (
            <Card key={l.id} className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-mono text-xs text-muted">{l.reference} · uploaded {formatDateTime(l.createdAt)}</p>
                  <h3 className="text-lg font-semibold">{l.externalEventName}</h3>
                  <p className="text-sm text-muted">
                    {l.externalVenue}, {l.externalCity} · {formatDateTime(start)}
                  </p>
                  <p className="text-sm text-muted">Seller: {sellerName} ({sellerEmail}) · payout {formatPhone(l.payoutPhone)}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold tabular-nums">{formatMoney(l.priceMinor)}</p>
                  {withdrawn.length > 0 && <Badge tone="info">Details replaced by admin</Badge>}
                </div>
              </div>
              <ChecksPanel listingId={l.id} status={l.checkStatus} result={l.checkResult as CheckResult | null} checkedAt={l.checkedAt} back={back} />
              <PanelTabs
                tabs={[
                  {
                    key: "ticket",
                    label: "Uploaded ticket",
                    content: (
                      <div className="space-y-4">
                        <div className="flex flex-wrap gap-2">
                          {docs.filter((d) => !d.withdrawnAt).map((d) => (
                            <a key={d.id} href={`/api/resale/documents/${d.id}`} className="inline-flex items-center gap-1.5 rounded-full bg-fg/8 px-3 py-1.5 text-sm hover:bg-fg/14">
                              <FileText className="size-4" aria-hidden /> {d.purpose === "ticket" ? "Ticket" : "Proof of purchase"} ({Math.ceil(d.sizeBytes / 1024)} KB)
                              {d.uploadedByName && <span className="text-xs text-muted">· replaced by {d.uploadedByName}</span>}
                            </a>
                          ))}
                        </div>
                        {docs.some((d) => d.withdrawnAt) && (
                          <div className="space-y-1.5 rounded-2xl bg-surface-2 p-3 text-sm">
                            <p className="text-xs font-semibold text-muted">Withdrawn files (kept for the record, never sent to buyers)</p>
                            {docs.filter((d) => d.withdrawnAt).map((d) => (
                              <a key={d.id} href={`/api/resale/documents/${d.id}`} className="flex flex-wrap items-center gap-1.5 text-muted hover:text-fg">
                                <FileText className="size-4" aria-hidden /> <span className="line-through">{d.filename}</span>
                                <span className="text-xs">withdrawn {formatDateTime(d.withdrawnAt!)}{d.withdrawnByName ? ` by ${d.withdrawnByName}` : ""}</span>
                              </a>
                            ))}
                          </div>
                        )}
                        <form action={replaceResaleTicketFileAction} className="space-y-3 rounded-2xl border border-line p-4">
                          <p className="text-sm font-semibold">Withdraw the ticket file and upload a new one</p>
                          <p className="text-xs text-muted">Use this when the seller uploaded the wrong or an unreadable file. PDF, JPG, PNG or WebP, up to 2 MB. The buyer only ever gets the newest file.</p>
                          <input type="hidden" name="listingId" value={l.id} />
                          <input type="hidden" name="back" value={back} />
                          <Input name="ticketFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="New ticket file" required />
                          <SubmitButton size="sm" variant="secondary">Withdraw old file &amp; save new</SubmitButton>
                        </form>
                      </div>
                    ),
                  },
                  {
                    key: "old",
                    label: "Withdraw old details",
                    content: (
                      <div className="space-y-4">
                        <div className="rounded-2xl border border-line p-4">
                          <p className="mb-3 text-sm font-semibold">Current details</p>
                          <DetailsList d={current} />
                        </div>
                        <p className="text-sm text-muted">
                          If these don&apos;t match the uploaded ticket, withdraw them by entering the correct details in <b>Enter new details</b>. The details withdrawn are kept here and in the audit log.
                        </p>
                        {withdrawn.map((w) => (
                          <div key={w.at.toISOString()} className="rounded-2xl bg-surface-2 p-4 opacity-80">
                            <p className="mb-3 text-xs text-muted">Withdrawn {formatDateTime(w.at)}{w.adminName ? ` by ${w.adminName}` : ""}</p>
                            <DetailsList d={w.details} />
                          </div>
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: "new",
                    label: "Enter new details",
                    content: (
                      <form action={replaceResaleDetailsAction} className="grid gap-3 sm:grid-cols-2">
                        <input type="hidden" name="listingId" value={l.id} />
                        <input type="hidden" name="back" value={back} />
                        <Field label="Event name" htmlFor={`n-${l.id}`} className="sm:col-span-2"><Input id={`n-${l.id}`} name="eventName" defaultValue={l.externalEventName ?? ""} required /></Field>
                        <Field label="Venue" htmlFor={`v-${l.id}`}><Input id={`v-${l.id}`} name="venue" defaultValue={l.externalVenue ?? ""} required /></Field>
                        <Field label="City" htmlFor={`c-${l.id}`}><Input id={`c-${l.id}`} name="city" defaultValue={l.externalCity ?? ""} required /></Field>
                        <Field label="Date and time (Nairobi)" htmlFor={`d-${l.id}`}><Input id={`d-${l.id}`} name="startsAtLocal" type="datetime-local" defaultValue={utcToZonedLocal(start)} required /></Field>
                        <Field label="Ticket type" htmlFor={`t-${l.id}`}><Input id={`t-${l.id}`} name="ticketTypeName" defaultValue={l.ticketTypeName} required /></Field>
                        <Field label="Bought on" htmlFor={`p-${l.id}`}><Input id={`p-${l.id}`} name="platform" defaultValue={l.externalPlatform ?? ""} required /></Field>
                        <Field label="Order number" htmlFor={`o-${l.id}`}><Input id={`o-${l.id}`} name="orderRef" defaultValue={l.externalOrderRef ?? ""} /></Field>
                        <Field label="M-Pesa code" htmlFor={`mp-${l.id}`}><Input id={`mp-${l.id}`} name="mpesaCode" defaultValue={l.externalMpesaCode ?? ""} placeholder="e.g. SJK3H7QX2P" /></Field>
                        <Field label="Note shown to buyers" htmlFor={`m-${l.id}`} className="sm:col-span-2"><Textarea id={`m-${l.id}`} name="note" defaultValue={l.sellerNote} className="min-h-20" /></Field>
                        <div className="sm:col-span-2"><SubmitButton size="sm">Withdraw old details &amp; save new</SubmitButton></div>
                      </form>
                    ),
                  },
                  {
                    key: "decide",
                    label: "List or reject",
                    content: (
                      <div className="grid gap-4 lg:grid-cols-3">
                        <form action={approveResaleAction} className="space-y-3 rounded-2xl border border-line p-4">
                          <p className="text-sm font-semibold">List under a TikoSoko event</p>
                          <input type="hidden" name="listingId" value={l.id} />
                          <input type="hidden" name="mode" value="link" />
                          <input type="hidden" name="back" value={back} />
                          <Select name="eventId" aria-label="Event" required defaultValue="">
                            <option value="" disabled>Choose event…</option>
                            {events.map((e) => (
                              <option key={e.id} value={e.id}>{e.title} · {formatDateTime(e.startsAt, e.timezone)}</option>
                            ))}
                          </Select>
                          <SubmitButton size="sm">List ticket</SubmitButton>
                        </form>
                        <form action={approveResaleAction} className="space-y-3 rounded-2xl border border-line p-4">
                          <p className="text-sm font-semibold">List under an outside event</p>
                          <input type="hidden" name="listingId" value={l.id} />
                          <input type="hidden" name="mode" value="create" />
                          <input type="hidden" name="back" value={back} />
                          <Input name="title" aria-label="Title" defaultValue={l.externalEventName ?? ""} required />
                          <div className="grid grid-cols-2 gap-2">
                            <Input name="venue" aria-label="Venue" defaultValue={l.externalVenue ?? ""} required />
                            <Input name="city" aria-label="City" defaultValue={l.externalCity ?? ""} required />
                          </div>
                          <Select name="category" aria-label="Category" defaultValue="music">
                            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </Select>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="Starts" htmlFor={`s-${l.id}`}><Input id={`s-${l.id}`} name="startsAtLocal" type="datetime-local" defaultValue={utcToZonedLocal(start)} required /></Field>
                            <Field label="Ends" htmlFor={`e-${l.id}`}><Input id={`e-${l.id}`} name="endsAtLocal" type="datetime-local" defaultValue={utcToZonedLocal(new Date(start.getTime() + 6 * 3600_000))} required /></Field>
                          </div>
                          <SubmitButton size="sm">List ticket</SubmitButton>
                        </form>
                        <form action={rejectResaleAction} className="space-y-3 rounded-2xl border border-line p-4">
                          <p className="text-sm font-semibold">Reject</p>
                          <input type="hidden" name="listingId" value={l.id} />
                          <input type="hidden" name="back" value={back} />
                          <Textarea name="note" aria-label="Reason for the seller" placeholder="Reason, sent to the seller" required minLength={5} className="min-h-24" />
                          <SubmitButton size="sm" variant="danger">Reject ticket</SubmitButton>
                        </form>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          );
        }),
      )}
    </div>
  );
}

async function ListingTable({ tab, back }: { tab: "active" | "all"; back: string }) {
  const rows = await adminListings(tab);
  return (
    <Table>
      <thead><tr><th>Listing</th><th>Kind</th><th>Event</th><th>Seller</th><th>Price</th><th>Status</th><th>Approved by</th><th /></tr></thead>
      <tbody>
        {rows.map(({ listing: l, eventTitle, eventIsExternal, eventCover, sellerName, sellerEmail, reviewerName, reviewerEmail }) => (
          <tr key={l.id}>
            <td className="font-mono text-xs">{l.reference}<span className="block font-sans text-muted">{formatDateTime(l.createdAt)}</span></td>
            <td><ResaleTrustBadge kind={l.kind} /></td>
            <td>
              {eventTitle ?? l.externalEventName}
              <span className="block text-xs text-muted">{l.ticketTypeName}</span>
              {l.status === "active" && eventIsExternal && !eventCover && <Badge tone="warning" className="mt-1">No banner</Badge>}
            </td>
            <td>{sellerName}<span className="block text-xs text-muted">{sellerEmail}</span></td>
            <td className="tabular-nums">{formatMoney(l.priceMinor)}</td>
            <td><Badge tone={LISTING_STATUS[l.status][1]}>{LISTING_STATUS[l.status][0]}</Badge></td>
            <td className="text-sm">
              {l.kind === "platform" ? (
                <span className="text-muted">No review needed</span>
              ) : reviewerName ? (
                <>
                  {l.status === "rejected" ? "Rejected by " : ""}{reviewerName}
                  <span className="block text-xs text-muted">{reviewerEmail}{l.reviewedAt ? ` · ${formatDateTime(l.reviewedAt)}` : ""}</span>
                </>
              ) : (
                <span className="text-muted">Not reviewed</span>
              )}
            </td>
            <td>
              {l.status === "active" && (
                <div className="flex flex-wrap gap-1">
                  {eventIsExternal && !eventCover && l.eventId && (
                    <form action={makeResaleBannerAction}>
                      <input type="hidden" name="eventId" value={l.eventId} />
                      <input type="hidden" name="back" value={back} />
                      <SubmitButton size="sm" variant="secondary">Make banner</SubmitButton>
                    </form>
                  )}
                  <form action={adminWithdrawResaleAction}>
                    <input type="hidden" name="listingId" value={l.id} />
                    <input type="hidden" name="back" value={back} />
                    <SubmitButton size="sm" variant="ghost">Withdraw</SubmitButton>
                  </form>
                </div>
              )}
            </td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={8} className="text-muted">Nothing here.</td></tr>}
      </tbody>
    </Table>
  );
}

async function Payouts({ tab, back }: { tab: "ready" | "held" | "disputed" | "paid"; back: string }) {
  const rows = await adminPayouts(tab);
  return (
    <Section title="Seller payouts">
      <Tabs
        active={tab}
        items={[
          { key: "ready", label: "Ready to pay", href: "/admin/resale?tab=payouts" },
          { key: "held", label: "In escrow", href: "/admin/resale?tab=payouts&p=held" },
          { key: "disputed", label: "Disputed", href: "/admin/resale?tab=payouts&p=disputed" },
          { key: "paid", label: "Paid / cancelled", href: "/admin/resale?tab=payouts&p=paid" },
        ]}
      />
      {tab === "ready" && <p className="text-sm text-muted">Send each amount from the M-Pesa org portal to the number shown, then record the receipt here.</p>}
      <Table>
        <thead><tr><th>Listing</th><th>Event / buyer</th><th>Seller</th><th>Amount</th><th>Release</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.payout.id}>
              <td className="font-mono text-xs">{r.listingRef}<span className="block">{r.bookingRef}</span></td>
              <td>{r.eventTitle}<span className="block text-xs text-muted">{r.buyerName} · {r.buyerEmail}</span></td>
              <td>{r.sellerName}<span className="block text-xs text-muted">{formatPhone(r.payout.payoutPhone)}</span></td>
              <td className="font-semibold tabular-nums">{formatMoney(r.payout.amountMinor)}</td>
              <td className="whitespace-nowrap text-xs">{formatDateTime(r.payout.releaseAt)}</td>
              <td>
                <span className="text-sm capitalize">{r.payout.status}</span>
                {r.payout.disputeReason && <span className="block max-w-56 text-xs text-danger">“{r.payout.disputeReason}”</span>}
                {r.payout.payoutReference && <span className="block font-mono text-xs text-muted">{r.payout.payoutReference}</span>}
                {r.payout.note && <span className="block text-xs text-muted">{r.payout.note}</span>}
              </td>
              <td className="min-w-56">
                {r.payout.status === "held" && r.payout.releaseAt <= new Date() && (
                  <form action={markResalePayoutPaidAction} className="flex gap-2">
                    <input type="hidden" name="payoutId" value={r.payout.id} />
                    <input type="hidden" name="back" value={back} />
                    <Input name="receipt" aria-label="M-Pesa receipt" placeholder="M-Pesa receipt" required className="!py-2 font-mono text-sm" />
                    <SubmitButton size="sm">Paid</SubmitButton>
                  </form>
                )}
                {r.payout.status === "disputed" && (
                  <form action={resolveResaleDisputeAction} className="space-y-2">
                    <input type="hidden" name="payoutId" value={r.payout.id} />
                    <input type="hidden" name="back" value={back} />
                    <Input name="note" aria-label="Decision note" placeholder="Decision note" className="!py-2 text-sm" />
                    <div className="flex gap-2">
                      <SubmitButton size="sm" variant="danger" name="decision" value="refund">Refund buyer</SubmitButton>
                      <SubmitButton size="sm" variant="secondary" name="decision" value="release">Pay seller</SubmitButton>
                    </div>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="text-muted">Nothing here.</td></tr>}
        </tbody>
      </Table>
    </Section>
  );
}
