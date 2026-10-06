import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { resolvePoolConfig } from "./pool-config";
import * as schema from "./schema";

const poolConfig = resolvePoolConfig(process.env);
const configuredDatabaseUrl = process.env.DATABASE_URL;
const neonFallbackUrl =
  configuredDatabaseUrl ??
  "postgresql://user:pass@localhost:5432/seldon_frame?sslmode=require";

// NEON_LOCAL_HOST only configures the existing Neon-local HTTP endpoint. It is
// independent of DB_DRIVER and is never required by the direct PostgreSQL path.
if (process.env.NEON_LOCAL_HOST) {
  const host = process.env.NEON_LOCAL_HOST;
  const port = process.env.NEON_LOCAL_PORT ?? "4444";
  neonConfig.fetchEndpoint = `http://${host}:${port}/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
}

type NeonDb = ReturnType<typeof drizzle<typeof schema>>;
type PooledDb = ReturnType<typeof drizzlePg<typeof schema>>;
type DatabaseSelection =
  | { driver: "neon"; client: NeonDb }
  | { driver: "pg"; client: PooledDb };

type GlobalWithPool = typeof globalThis & { __sfPgPool?: Pool };

function createDatabase(): DatabaseSelection {
  if (!poolConfig) {
    return {
      driver: "neon",
      client: drizzle(neon(neonFallbackUrl), { schema, casing: "snake_case" }),
    };
  }
  if (!configuredDatabaseUrl) {
    throw new Error("DATABASE_URL is required when DB_DRIVER=pg");
  }

  const global = globalThis as GlobalWithPool;
  if (!global.__sfPgPool) {
    global.__sfPgPool = new Pool({
      connectionString: configuredDatabaseUrl,
      ...poolConfig,
    });
    global.__sfPgPool.on("error", (error) => {
      // Log a non-sensitive category only; driver messages may contain details.
      const code = "code" in error && typeof error.code === "string" ? error.code : "unknown";
      console.error("[db] idle pool client error", code);
    });
  }

  return {
    driver: "pg",
    client: drizzlePg(global.__sfPgPool, { schema, casing: "snake_case" }),
  };
}

const selectedDatabase = createDatabase();

/** Shared schema-aware query surface; intentionally excludes Neon-only batch(). */
export type DbClient = PgDatabase<any, typeof schema>;
export const db: DbClient = selectedDatabase.client;
export const dbDriver = selectedDatabase.driver;

type NeonBatchInput = Parameters<NeonDb["batch"]>[0];

export function runNeonBatch(
  build: (client: NeonDb) => NeonBatchInput,
): ReturnType<NeonDb["batch"]> {
  if (selectedDatabase.driver !== "neon") {
    throw new Error("Neon batch is unavailable when DB_DRIVER=pg");
  }
  return selectedDatabase.client.batch(build(selectedDatabase.client));
}
