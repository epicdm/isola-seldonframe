#!/usr/bin/env node
// Applies the repo's drizzle SQL migrations to a DISPOSABLE local Postgres,
// via drizzle's own node-postgres migrator. Refuses any non-loopback host.
//   TEST_DATABASE_URL=postgres://postgres:***@127.0.0.1:55433/postgres node scripts/migrate-test-db.mjs
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL not set");
  process.exit(2);
}
const host = new URL(url).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`refusing: host ${host} is not loopback`);
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url });
// MIGRATIONS_FOLDER lets a scratch run use a patched copy: 0001_solid_gateway.sql
// casts accounts.expires_at timestamp->integer without USING, which only works
// on prod where that was applied out-of-band, so a from-zero replay fails there.
const folder = process.env.MIGRATIONS_FOLDER ?? resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
await migrate(drizzle(pool), { migrationsFolder: folder });
console.log("migrations applied");
await pool.end();
