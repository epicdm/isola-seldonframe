// EPIC 2026-10-20 (Codex r2): ONE clock for operator-session issuance and cut-offs. Row locks order a magic-link consume against an
// ownership transfer; only a single clock turns that order into an ordering of timestamps (two application processes can disagree by
// seconds). The database clock is that clock: clock_timestamp() advances inside a transaction, unlike now().
import { sql } from "drizzle-orm";
import type { db } from "./index";

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Milliseconds since the epoch from the database clock (clock_timestamp()). Throws when the value is unusable (fail closed). */
export async function dbClockMs(client: DbClient): Promise<number> {
  const r = await client.execute(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as t`);
  const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{ t?: string }>;
  const t = Number(rows[0]?.t);
  if (!Number.isFinite(t) || t <= 0) throw new Error("db_clock_unavailable");
  return t;
}
