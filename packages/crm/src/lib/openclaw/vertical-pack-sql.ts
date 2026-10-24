import { sql } from "drizzle-orm";

/** Build a PostgreSQL text[] expression from individually bound values. */
export function textArrayExpression(values: string[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}
