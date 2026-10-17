/**
 * One-time (idempotent) Supabase setup for a serverless deployment:
 *   1. Storage: a public "event-images" bucket (4 MB, JPG/PNG/WebP only), checked with a test upload.
 *   2. Background work: Supabase Cron (pg_cron + pg_net) calls <APP_BASE_URL>/api/cron/tick every
 *      minute with CRON_SECRET, which is kept in Supabase Vault rather than in the job text.
 *
 * Usage: npx tsx scripts/supabase-setup.ts <https://your-site>
 * Reads SUPABASE_DATABASE_URL (or DATABASE_URL), SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET.
 * Never prints secrets.
 */
import "dotenv/config";
import { Pool } from "pg";
import { poolConfig } from "../src/db/connection";
import { supabaseStorageConfig } from "../src/server/storage";

// 1x1 PNG used for the upload check (removed again afterwards).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function setupStorage() {
  const { url, key, bucket } = supabaseStorageConfig();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const settings = { public: true, file_size_limit: 4 * 1024 * 1024, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] };
  let res = await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers, body: JSON.stringify({ id: bucket, name: bucket, ...settings }) });
  if (!res.ok) {
    const body = await res.text();
    if (!/already exists|Duplicate|409/i.test(body + res.status)) throw new Error(`Creating bucket failed: ${res.status} ${body.slice(0, 200)}`);
    res = await fetch(`${url}/storage/v1/bucket/${bucket}`, { method: "PUT", headers, body: JSON.stringify(settings) });
    if (!res.ok) throw new Error(`Updating bucket failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`Storage: bucket "${bucket}" already existed, settings updated`);
  } else console.log(`Storage: bucket "${bucket}" created (public, 4 MB, JPG/PNG/WebP)`);

  const testKey = `_setup-check/${Date.now()}.png`;
  const up = await fetch(`${url}/storage/v1/object/${bucket}/${testKey}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "image/png" }, body: PNG });
  if (!up.ok) throw new Error(`Test upload failed: ${up.status} ${(await up.text()).slice(0, 200)}`);
  const pub = await fetch(`${url}/storage/v1/object/public/${bucket}/${testKey}`);
  console.log(`Storage: test upload ok, public read ${pub.ok ? "ok" : `FAILED (${pub.status})`}`);
  await fetch(`${url}/storage/v1/object/${bucket}`, { method: "DELETE", headers, body: JSON.stringify({ prefixes: [testKey] }) });
  if (!pub.ok) throw new Error("Public read of the bucket failed");
}

async function setupCron(siteUrl: string) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) throw new Error("CRON_SECRET must be set (at least 16 characters)");
  const dbUrl = (process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL)?.trim();
  if (!dbUrl) throw new Error("SUPABASE_DATABASE_URL is not set");
  const pool = new Pool(poolConfig(dbUrl, 1));
  try {
    await pool.query("create extension if not exists pg_cron");
    await pool.query("create extension if not exists pg_net");
    const existing = await pool.query("select id from vault.secrets where name = 'tikosoko_cron_secret'");
    if (existing.rows[0]) await pool.query("select vault.update_secret($1, $2)", [existing.rows[0].id, secret]);
    else await pool.query("select vault.create_secret($1, 'tikosoko_cron_secret', 'Bearer token for /api/cron/tick')", [secret]);
    const endpoint = `${siteUrl.replace(/\/+$/, "")}/api/cron/tick`;
    const command = `select net.http_post(
      url := ${pgLiteral(endpoint)},
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tikosoko_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    )`;
    await pool.query("select cron.schedule('tikosoko-tick', '* * * * *', $1)", [command]);
    console.log(`Cron: "tikosoko-tick" runs every minute → ${endpoint}`);
  } finally {
    await pool.end();
  }
}

function pgLiteral(s: string) {
  if (!/^https:\/\/[\w.-]+(:\d+)?\/[\w/.-]*$/.test(s)) throw new Error("Unexpected site URL");
  return `'${s}'`;
}

async function main() {
  const site = process.argv[2] ?? process.env.APP_BASE_URL;
  if (!site || !site.startsWith("https://")) throw new Error("Pass your site's https URL, e.g. npx tsx scripts/supabase-setup.ts https://tikosoko.vercel.app");
  await setupStorage();
  await setupCron(site);
}

main().catch((e) => {
  console.error("Setup failed:", (e as Error).message);
  process.exit(1);
});
