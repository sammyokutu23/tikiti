/**
 * Local development PostgreSQL server (real Postgres binaries via embedded-postgres).
 * Nothing is installed system-wide; data lives in ./.data/postgres.
 *
 *   npm run db:start   -> starts the server in the foreground (Ctrl+C to stop)
 *
 * Production: point DATABASE_URL at a managed PostgreSQL instance instead.
 */
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const dataDir = path.resolve(process.cwd(), ".data/postgres");
const databases = ["tikiti", "tikiti_test"];

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: true,
    onLog: () => {},
  });

  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log("Initialising local PostgreSQL cluster in .data/postgres …");
    await pg.initialise();
  }
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();
  for (const db of databases) {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (!rowCount) {
      await client.query(`CREATE DATABASE ${db}`);
      console.log(`Created database ${db}`);
    }
  }
  await client.end();

  console.log(`PostgreSQL ready on postgres://postgres:postgres@localhost:${port}/tikiti`);

  const shutdown = async () => {
    console.log("\nStopping PostgreSQL …");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep process alive
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
