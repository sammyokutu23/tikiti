import { db, type Tx } from "@/db";
import { auditLogs } from "@/db/schema";

export async function audit(
  tx: Tx | null,
  entry: {
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await (tx ?? db).insert(auditLogs).values({
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
  });
}
