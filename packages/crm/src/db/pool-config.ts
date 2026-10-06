// Pure env -> pg Pool options. Kept separate from db/index.ts so it can be unit
// tested without constructing a connection.

export type PoolConfig = {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  allowExitOnIdle: boolean;
};

function intFrom(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${key}: expected an integer between ${min} and ${max}`);
  }
  return value;
}

export function resolvePoolConfig(env: Record<string, string | undefined>): PoolConfig | null {
  const driver = env.DB_DRIVER?.trim();
  if (driver === undefined || driver === "" || driver === "neon") return null;
  if (driver !== "pg") throw new Error(`Unsupported DB_DRIVER: ${driver}`);

  return {
    max: intFrom(env, "DB_POOL_MAX", 10, 1, 50),
    idleTimeoutMillis: intFrom(env, "DB_POOL_IDLE_MS", 30_000, 1_000, 600_000),
    connectionTimeoutMillis: intFrom(env, "DB_POOL_CONNECT_TIMEOUT_MS", 5_000, 500, 60_000),
    statement_timeout: intFrom(env, "DB_STATEMENT_TIMEOUT_MS", 30_000, 1_000, 300_000),
    allowExitOnIdle: true,
  };
}
