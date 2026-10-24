import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { textArrayExpression } from "../../../src/lib/openclaw/vertical-pack-sql";

test("vertical pack block names are bound as a PostgreSQL text array", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(textArrayExpression(["forms", "bookings"]));

  assert.equal(query.sql, "ARRAY[$1, $2]::text[]");
  assert.deepEqual(query.params, ["forms", "bookings"]);

  const empty = dialect.sqlToQuery(textArrayExpression([]));
  assert.equal(empty.sql, "ARRAY[]::text[]");
  assert.deepEqual(empty.params, []);
});
