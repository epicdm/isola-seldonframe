#!/usr/bin/env node
// packages/crm/scripts/assert-schema-drift.mjs
//
// 2026-05-29 — Build-time safety net for "schema says X, the DB doesn't have X".
//
// The deeper failure behind both outages is that the Drizzle schema declared a
// column the live DB didn't have — and nothing caught it until an authenticated
// request SELECTed that column and 500'd. `drizzle-kit migrate` can't catch it
// (an un-journaled migration is invisible to it), and migrate-tolerant only
// sees errors drizzle actually raises. This guard closes the gap: AFTER migrate,
// BEFORE `next build`, it asks the live DB whether a curated list of critical
// columns actually exist. If one is missing, the build fails with a message
// naming the column and the migration that should have added it.
//
// Scope (deliberately small — see note at bottom): a CURATED list of critical
// columns, not a full schema diff. A full schema-vs-DB diff would be ideal but
// is a large lift; the curated list catches the actual failure mode (a new
// auth/billing column not applying) in a few lines of SQL.
//
// Usage (from packages/crm), uses DATABASE_URL and DB_DRIVER like the application:
//   DB_DRIVER=pg node scripts/assert-schema-drift.mjs
//   node scripts/assert-schema-drift.mjs  # legacy Neon default
//
// Skips cleanly when DATABASE_URL is unset (local builds, CI without a DB).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

/**
 * Curated list of CRITICAL columns the live DB must have. "Critical" =
 * read on a hot/authenticated path such that a missing column 500s real
 * requests. Seeded with the two columns that actually caused outages, plus
 * their close billing/onboarding/scheduling neighbors.
 *
 * GROW THIS LIST whenever you add a column that is read (not just written) on
 * an authenticated or public request path — especially NOT-NULL-on-read columns
 * in users / organizations. That is the precise shape of bug this guard exists
 * to catch. Each entry names the migration that introduces the column so a
 * failure points straight at the un-applied migration.
 *
 * @type {{table: string, column: string, migration: string, why: string}[]}
 */
export const CRITICAL_COLUMNS = [
  {
    table: "users",
    column: "stripe_payment_method_id",
    migration: "0019_silky_viper",
    why: "INCIDENT 1 — read on /signup/billing; missing column 500'd signup.",
  },
  {
    table: "users",
    column: "onboarding_completed_at",
    migration: "0055_users_onboarding_completed_at",
    why: "INCIDENT 2 — getOnboardingState SELECTs it on /clients/new; 500'd EVERY authenticated user.",
  },
  {
    table: "users",
    column: "stripe_customer_id",
    migration: "0003_billing_subscription_fields",
    why: "Read on billing/subscription-kickoff paths.",
  },
  {
    table: "users",
    column: "agency_profile",
    migration: "0045_users_agency_profile",
    why: "NOT NULL; read on agency/dashboard surfaces.",
  },
  {
    table: "organizations",
    column: "timezone",
    migration: "0022_organizations_timezone",
    why: "NOT NULL DEFAULT 'UTC'; read on scheduled-trigger next-fire computation.",
  },
  {
    table: "organizations",
    column: "is_internal",
    migration: "0078_organizations_is_internal",
    why: "NOT NULL DEFAULT false; no reader yet (staged for growth-metrics exclusion) — guarded because Drizzle full-row selects on organizations 500 if the column is schema-declared but unapplied.",
  },
];

/**
 * Pure core — extracted so it's unit-testable without a DB. Given the set of
 * columns the live DB actually has (as "table.column" strings) and the list of
 * required critical columns, return the required ones that are missing.
 *
 * @param {Set<string>|string[]} liveColumns - "table.column" present in the DB
 * @param {{table: string, column: string}[]} requiredColumns
 * @returns {{table: string, column: string}[]} the missing subset
 */
export function missingColumns(liveColumns, requiredColumns) {
  const live = liveColumns instanceof Set ? liveColumns : new Set(liveColumns);
  return requiredColumns.filter((req) => !live.has(`${req.table}.${req.column}`));
}

async function fetchLiveColumns(sql, required) {
  // One round-trip: ask information_schema for exactly the (table, column)
  // pairs we care about. Returns a Set of "table.column".
  const tables = [...new Set(required.map((r) => r.table))];
  const columns = [...new Set(required.map((r) => r.column))];
  const rows = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(${tables})
      AND column_name = ANY(${columns})
  `;
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

export function resolveDriftDriver(env = process.env) {
  const driver = env.DB_DRIVER?.trim();
  if (!driver || driver === "neon") return "neon";
  if (driver === "pg") return "pg";
  throw new Error(`Unsupported DB_DRIVER: ${driver}`);
}

export async function fetchLiveColumnsPg(query, required) {
  const tables = [...new Set(required.map((r) => r.table))];
  const columns = [...new Set(required.map((r) => r.column))];
  const { rows } = await query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND column_name = ANY($2::text[])`,
    [tables, columns],
  );
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("[assert-schema-drift] DATABASE_URL not set — skipping");
    return 0;
  }

  let pool;
  let live;
  try {
    const driver = resolveDriftDriver();
    if (driver === "pg") {
      const { Pool } = await import("pg");
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 1_000,
        statement_timeout: 10_000,
        allowExitOnIdle: true,
      });
      live = await fetchLiveColumnsPg(pool.query.bind(pool), CRITICAL_COLUMNS);
    } else {
      const sql = neon(process.env.DATABASE_URL);
      live = await fetchLiveColumns(sql, CRITICAL_COLUMNS);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unsupported DB_DRIVER:")) {
      console.error(`[assert-schema-drift] FATAL: ${err.message}`);
    } else {
      console.error("[assert-schema-drift] FATAL: could not query the database with the selected driver");
    }
    return 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Preserve the original check result; no connection details are logged.
      }
    }
  }

  const missing = missingColumns(live, CRITICAL_COLUMNS);

  if (missing.length === 0) {
    console.log(
      `[assert-schema-drift] OK — all ${CRITICAL_COLUMNS.length} critical column(s) present.`,
    );
    return 0;
  }

  console.error(
    `[assert-schema-drift] FATAL: ${missing.length} critical column(s) declared by the ` +
      `Drizzle schema are MISSING from the live database:`,
  );
  for (const col of missing) {
    const meta = CRITICAL_COLUMNS.find((c) => c.table === col.table && c.column === col.column);
    console.error(`  • ${col.table}.${col.column}`);
    console.error(`      should be added by: drizzle/${meta?.migration ?? "(unknown)"}.sql`);
    if (meta?.why) console.error(`      why it's critical: ${meta.why}`);
  }
  console.error("");
  console.error(
    "A migration that adds one of these columns did not apply. Verify it is in " +
      "meta/_journal.json and apply the named migration before deployment.",
  );
  return 1;
}

// Only run when invoked directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().then((code) => { process.exitCode = code; });
