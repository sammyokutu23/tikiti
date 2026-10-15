import { Flash } from "@/components/dash/flash";
import { Alert, Card, Field, Input, PageHeader, Section, Stat, StatusBadge, Table } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { requireAdmin } from "@/server/auth/guards";
import { imageApiStatus } from "@/server/banners/openai";
import { bannerAdminOverview, bannerLimits, bannerUsage } from "@/server/banners/service";
import { setBannerLimitsAction } from "../actions";

export const metadata = { title: "AI banners" };

export default async function AdminBannersPage({ searchParams }: PageProps<"/admin/ai-banners">) {
  await requireAdmin();
  const sp = await searchParams;
  const [limits, usage, { recent, byOrganizer, failures }] = await Promise.all([bannerLimits(), bannerUsage(null), bannerAdminOverview()]);
  const api = imageApiStatus();

  return (
    <div className="space-y-8">
      <PageHeader title="AI banners" subtitle="OpenAI image generation for organizers: configuration, spending limits and usage." />
      <Flash sp={sp} />
      {api.configured ? (
        <Alert tone="success" title="OpenAI configured">Model <code>{api.model}</code>, quality <code>{api.quality}</code>. The API key is server-only and never shown.</Alert>
      ) : (
        <Alert tone="warning" title="OpenAI not configured">{api.problem}. Set OPENAI_API_KEY and OPENAI_IMAGE_MODEL (see docs/AI_BANNERS.md). Organizers can still upload images.</Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Images (30 days)" value={`${usage.platformMonth} / ${limits.imagesPlatformPerMonth}`} hint="Pending + completed" />
        <Stat label="Failed requests (30 days)" value={failures} hint="Not counted toward limits" />
        <Stat label="Per organizer / day" value={limits.imagesPerOrganizerPerDay} />
        <Stat label="Per organizer / 30 days" value={limits.imagesPerOrganizerPerMonth} />
      </div>

      <Section title="Limits">
        <Card className="p-5">
          <form action={setBannerLimitsAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
              <input type="checkbox" name="enabled" defaultChecked={limits.enabled} className="size-4" /> AI banner generation enabled
            </label>
            <Field label="Images per organizer per 24 h" htmlFor="d"><Input id="d" name="imagesPerOrganizerPerDay" type="number" min={0} max={500} defaultValue={limits.imagesPerOrganizerPerDay} /></Field>
            <Field label="Images per organizer per 30 days" htmlFor="m"><Input id="m" name="imagesPerOrganizerPerMonth" type="number" min={0} max={5000} defaultValue={limits.imagesPerOrganizerPerMonth} /></Field>
            <Field label="Platform images per 30 days" htmlFor="p" hint="Hard cap on total spend."><Input id="p" name="imagesPlatformPerMonth" type="number" min={0} max={100000} defaultValue={limits.imagesPlatformPerMonth} /></Field>
            <Field label="Max images per request" htmlFor="r"><Input id="r" name="maxImagesPerRequest" type="number" min={1} max={4} defaultValue={limits.maxImagesPerRequest} /></Field>
            <Field label="Requests per user per minute" htmlFor="u"><Input id="u" name="requestsPerUserPerMinute" type="number" min={1} max={30} defaultValue={limits.requestsPerUserPerMinute} /></Field>
            <div className="flex items-end"><SubmitButton>Save limits</SubmitButton></div>
          </form>
          <p className="mt-4 text-xs text-muted">Each image is billed by OpenAI according to the configured model and quality (see your OpenAI usage dashboard for actual cost). Pricing isn&apos;t hard-coded here.</p>
        </Card>
      </Section>

      <Section title="Top organizers (30 days)">
        <Table>
          <thead><tr><th>Organizer</th><th>Requests</th><th>Images generated</th></tr></thead>
          <tbody>
            {byOrganizer.map((r) => <tr key={r.organizer}><td>{r.organizer}</td><td>{r.requests}</td><td>{r.images ?? 0}</td></tr>)}
            {byOrganizer.length === 0 && <tr><td colSpan={3} className="text-muted">No usage yet.</td></tr>}
          </tbody>
        </Table>
      </Section>

      <Section title="Recent generations">
        <Table>
          <thead><tr><th>When</th><th>Organizer</th><th>Event</th><th>Status</th><th>Images</th><th>Model</th><th>Problem</th></tr></thead>
          <tbody>
            {recent.map(({ g, event, organizer }) => (
              <tr key={g.id}>
                <td className="whitespace-nowrap">{formatDateTime(g.createdAt)}</td>
                <td>{organizer}</td>
                <td>{event}</td>
                <td><StatusBadge status={g.status} /></td>
                <td>{g.imageCount}</td>
                <td><code className="text-xs">{g.model}</code></td>
                <td className="text-xs text-muted">{g.errorCategory ?? ""}</td>
              </tr>
            ))}
            {recent.length === 0 && <tr><td colSpan={7} className="text-muted">Nothing generated yet.</td></tr>}
          </tbody>
        </Table>
      </Section>
    </div>
  );
}
