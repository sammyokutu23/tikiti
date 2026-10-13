import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction — services accept either. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

const globalForDb = globalThis as unknown as { __tikitiPool?: Pool; __tikitiDb?: Database };

function createDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  globalForDb.__tikitiPool = pool;
  return drizzle(pool, { schema });
}

/** Lazily-created singleton (survives dev hot reloads). */
export function getDb(): Database {
  if (!globalForDb.__tikitiDb) globalForDb.__tikitiDb = createDb();
  return globalForDb.__tikitiDb;
}

export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

export async function closeDb() {
  await globalForDb.__tikitiPool?.end();
  globalForDb.__tikitiPool = undefined;
  globalForDb.__tikitiDb = undefined;
}

export { schema };
