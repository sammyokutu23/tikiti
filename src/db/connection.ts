import type { PoolConfig } from "pg";

/**
 * Pool settings for a Postgres URL. Hosted databases (Supabase, Neon, …) need TLS:
 * set DATABASE_SSL=require (automatic for *.supabase.com / *.supabase.co / *.neon.tech).
 * DATABASE_CA_CERT (PEM) enables full certificate verification, e.g. Supabase's
 * "Download certificate" from Database → Settings → SSL.
 */
export function poolConfig(url: string, max: number): PoolConfig {
  const u = new URL(url);
  const hosted = /\.(supabase\.(com|co)|neon\.tech)$/i.test(u.hostname);
  const mode = process.env.DATABASE_SSL ?? (hosted ? "require" : u.searchParams.get("sslmode") ?? "disable");
  if (mode === "disable") return { connectionString: url, max };
  // pg lets URL parameters override `ssl`, so TLS is configured here only.
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) u.searchParams.delete(p);
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
  return {
    connectionString: u.toString(),
    max,
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
}
