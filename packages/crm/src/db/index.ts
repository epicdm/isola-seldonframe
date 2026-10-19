import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { resolvePoolConfig } from "./pool-config";
import * as schema from "./schema";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://user:pass@localhost:5432/seldon_frame?sslmode=require";

// Self-hosting escape hatch. In production SeldonFrame runs on Neon, whose
// serverless driver speaks SQL-over-HTTPS to `<host>/sql`. A self-hoster
// pointing DATABASE_URL at a plain Postgres has no such endpoint — so the
// docker-compose stack runs the Neon local HTTP proxy in front of Postgres,
// and this block redirects the driver's fetch to it. Gated on NEON_LOCAL_HOST:
// unset in production, so prod behaviour is byte-identical.
if (process.env.NEON_LOCAL_HOST) {
  const host = process.env.NEON_LOCAL_HOST;
  const port = process.env.NEON_LOCAL_PORT ?? "4444";
  neonConfig.fetchEndpoint = `http://${host}:${port}/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
}

// Self-hosted pooled path (opt-in). The Neon local HTTP proxy authenticates
// every HTTP request with a fresh SCRAM handshake (~250 ms), which dominates
// page latency on query-heavy renders. DB_DRIVER=pg talks to Postgres directly
// over a small, long-lived node-postgres pool instead. It is only honoured when
// NEON_LOCAL_HOST is set (i.e. self-hosted); production Neon is unaffected.
// Unset DB_DRIVER (the default) keeps the neon-http path above, byte-identical.
const poolConfig = resolvePoolConfig(process.env);

type GlobalWithPool = typeof globalThis & { __sfPgPool?: Pool };

function createDb() {
  if (poolConfig) {
    const g = globalThis as GlobalWithPool;
    // Singleton across Next.js dev reloads / module re-evaluation so the pool
    // (and its connections) is never duplicated within one process.
    if (!g.__sfPgPool) {
      g.__sfPgPool = new Pool({ connectionString: databaseUrl, ...poolConfig });
      g.__sfPgPool.on("error", (err) => {
        console.error("[db] idle pool client error", err.message);
      });
    }
    return drizzlePg(g.__sfPgPool, { schema, casing: "snake_case" }) as unknown as NeonDb;
  }
  return drizzle(neon(databaseUrl), { schema, casing: "snake_case" });
}

type NeonDb = ReturnType<typeof drizzle<typeof schema>>;

export const db: NeonDb = createDb();

export type DbClient = typeof db;
