/** Shows the last few Supabase Cron tick calls (job name, time, HTTP status). Never prints secrets. */
import "dotenv/config";
import { Pool } from "pg";
import { poolConfig } from "../src/db/connection";

const pool = new Pool(poolConfig((process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL)!, 1));
const jobs = await pool.query("select jobname, active from cron.job order by jobid");
console.log("Jobs:", jobs.rows.map((j) => `${j.jobname}${j.active ? "" : " (inactive)"}`).join(", ") || "none");
const calls = await pool.query("select status_code, created from net._http_response order by created desc limit 3");
for (const c of calls.rows) console.log(`  ${new Date(c.created).toISOString()}  HTTP ${c.status_code ?? "no response"}`);
await pool.end();
