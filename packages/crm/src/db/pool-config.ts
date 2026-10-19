// Pure env -> pg Pool options. Kept separate from db/index.ts so it can be unit
// tested without constructing a connection.
//
// Returns null unless the operator explicitly opts in with DB_DRIVER=pg AND the
// deployment is self-hosted (NEON_LOCAL_HOST set). Anything else -> neon-http.

export type PoolConfig = {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  allowExitOnIdle: boolean;
};

function intFrom(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function resolvePoolConfig(env: Record<string, string | undefined>): PoolConfig | null {
  if (env.DB_DRIVER !== "pg") return null;
  if (!env.NEON_LOCAL_HOST) return null;
  return {
    max: intFrom(env.DB_POOL_MAX, 10, 1, 50),
    idleTimeoutMillis: intFrom(env.DB_POOL_IDLE_MS, 30_000, 1_000, 600_000),
    connectionTimeoutMillis: intFrom(env.DB_POOL_CONNECT_TIMEOUT_MS, 5_000, 500, 60_000),
    statement_timeout: intFrom(env.DB_STATEMENT_TIMEOUT_MS, 30_000, 1_000, 300_000),
    allowExitOnIdle: false,
  };
}
