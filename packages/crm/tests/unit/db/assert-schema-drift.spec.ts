import test from "node:test";
import assert from "node:assert/strict";
import { fetchLiveColumnsPg, resolveDriftDriver } from "../../../scripts/assert-schema-drift.mjs";

test("schema drift defaults to Neon unless pg is explicitly selected", () => {
  assert.equal(resolveDriftDriver({}), "neon");
  assert.equal(resolveDriftDriver({ DB_DRIVER: "" }), "neon");
  assert.equal(resolveDriftDriver({ DB_DRIVER: "neon" }), "neon");
  assert.equal(resolveDriftDriver({ DB_DRIVER: "pg" }), "pg");
  assert.throws(() => resolveDriftDriver({ DB_DRIVER: "postgres" }), /Unsupported DB_DRIVER/);
});

test("PostgreSQL drift query is parameterized and returns public column names", async () => {
  let captured: { sql: string; params: unknown[] } = { sql: "", params: [] };
  const columns = await fetchLiveColumnsPg(async (sql: string, params: unknown[]) => {
    captured = { sql, params };
    return { rows: [{ table_name: "users", column_name: "agency_profile" }] };
  }, [
    { table: "users", column: "agency_profile" },
    { table: "users", column: "agency_profile" },
    { table: "organizations", column: "timezone" },
  ]);
  assert.deepEqual([...columns], ["users.agency_profile"]);
  assert.match(captured.sql, /table_name = ANY\(\$1::text\[\]\)/);
  assert.match(captured.sql, /column_name = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(captured.params, [["users", "organizations"], ["agency_profile", "timezone"]]);
});
