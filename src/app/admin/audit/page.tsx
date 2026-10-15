import { desc, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { PageHeader, Table } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";

export const metadata = { title: "Audit log" };

export default async function AdminAudit({ searchParams }: PageProps<"/admin/audit">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 60) : "";
  const rows = await db
    .select({ a: auditLogs, actor: users.email })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(q ? ilike(auditLogs.action, `%${q.replace(/[%_\\]/g, "")}%`) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(300);
  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" subtitle="Sensitive actions across the platform." />
      <form className="max-w-sm">
        <label htmlFor="aq2" className="sr-only">Filter by action</label>
        <input id="aq2" name="q" defaultValue={q} placeholder="Filter action, e.g. refund" className="h-11 w-full rounded-full border border-line bg-fg/5 px-4 text-sm focus:outline-none" />
      </form>
      <Table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map(({ a, actor }) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap text-xs">{formatDateTime(a.createdAt)}</td>
              <td className="text-xs">{actor ?? "system"}</td>
              <td className="font-mono text-xs">{a.action}</td>
              <td className="text-xs text-muted">{a.entityType}:{a.entityId?.slice(0, 8)}</td>
              <td className="max-w-72 truncate font-mono text-[11px] text-muted">{JSON.stringify(a.metadata)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
