import { ArrowLeft } from "lucide-react";
import { Alert, Card, IconLink } from "@/components/ui";
import { formatPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";
import { PAYOUT_HOLD_HOURS } from "@/server/resale/policy";
import { scanConfig } from "@/server/resale/scan";
import { ExternalListingForm } from "../../forms";

export const metadata = { title: "Sell an outside ticket" };

export default async function SellOutsideTicketPage() {
  const user = await requireUser("/resale/sell/outside");
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <div className="flex items-center gap-3">
        <IconLink href="/resale/sell" label="Back"><ArrowLeft className="size-5" aria-hidden /></IconLink>
        <div>
          <p className="text-xs text-muted">Resale</p>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Sell a ticket bought elsewhere</h1>
        </div>
      </div>
      <Alert tone="info" title="How it works">
        <ol className="list-inside list-decimal space-y-1">
          <li>Upload the ticket and your proof of purchase{scanConfig() ? ", then scan the ticket to fill in its details" : ""}. Set your price and submit it for review. Our team checks it, usually within a day.</li>
          <li>Once approved, your ticket appears on the resale marketplace.</li>
          <li>When it sells, the buyer downloads your ticket file. Don&apos;t use or share it again.</li>
          <li>We pay you on M-Pesa {PAYOUT_HOLD_HOURS.external} hours after the event, as long as the buyer didn&apos;t report a problem.</li>
        </ol>
      </Alert>
      <Card className="p-5 sm:p-6">
        <ExternalListingForm defaultPhone={user.phone ? formatPhone(user.phone) : ""} canScan={scanConfig() !== null} />
      </Card>
    </div>
  );
}
