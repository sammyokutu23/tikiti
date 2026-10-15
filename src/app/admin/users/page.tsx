import { desc, ilike, or } from "drizzle-orm";
import { Search } from "lucide-react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Badge, PageHeader, StatusBadge, Table } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { requireAdmin } from "@/server/auth/guards";
import { setUserStatusAction } from "../actions";

export const metadata = { title: "Users" };

export default async function AdminUsers({ searchParams }: PageProps<"/admin/users">) {
  const me = await requireAdmin();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const t = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db.select().from(users).where(q ? or(ilike(users.email, t), ilike(users.name, t)) : undefined).orderBy(desc(users.createdAt)).limit(300);
  return (
    <div className="space-y-6">
      <PageHeader title="Users" subtitle="Roles follow organizer verification; suspend accounts that abuse the platform." />
      <Flash sp={sp} />
      <form className="relative max-w-md" role="search">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <label htmlFor="uq" className="sr-only">Search users</label>
        <input id="uq" name="q" defaultValue={q} placeholder="Name or email" className="h-11 w-full rounded-full border border-line bg-fg/5 pl-11 pr-4 text-sm focus:outline-none" />
      </form>
      <Table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th /></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="text-xs">{u.email}</td>
              <td><Badge tone={u.role === "admin" ? "info" : u.role === "organizer" ? "success" : "neutral"}>{u.role}</Badge></td>
              <td><StatusBadge status={u.status} /></td>
              <td className="text-xs text-muted">{formatDateTime(u.createdAt)}</td>
              <td>
                {u.id !== me.id && (
                  <form action={setUserStatusAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    {u.status === "active" ? (
                      <ConfirmButton name="status" value="suspended" size="sm" variant="ghost" message={`Suspend ${u.email}? They'll be signed out everywhere.`}>Suspend</ConfirmButton>
                    ) : (
                      <SubmitButton name="status" value="active" size="sm" variant="secondary">Reactivate</SubmitButton>
                    )}
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
