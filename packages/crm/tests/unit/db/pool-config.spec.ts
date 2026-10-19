// Run: node --import tsx --test tests/unit/db/pool-config.spec.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolvePoolConfig } from "../../../src/db/pool-config";

describe("resolvePoolConfig", () => {
  test("default (DB_DRIVER unset) keeps neon-http", () => {
    assert.equal(resolvePoolConfig({ NEON_LOCAL_HOST: "neon-proxy" }), null);
  });
  test("DB_DRIVER=pg without NEON_LOCAL_HOST (production Neon) is ignored", () => {
    assert.equal(resolvePoolConfig({ DB_DRIVER: "pg" }), null);
  });
  test("other DB_DRIVER values are ignored", () => {
    assert.equal(resolvePoolConfig({ DB_DRIVER: "PG", NEON_LOCAL_HOST: "x" }), null);
  });
  test("positive control: pg + self-hosted yields bounded defaults", () => {
    const c = resolvePoolConfig({ DB_DRIVER: "pg", NEON_LOCAL_HOST: "x" });
    assert.ok(c);
    assert.equal(c.max, 10);
    assert.equal(c.connectionTimeoutMillis, 5000);
  });
  test("pool size override is honoured and clamped", () => {
    const base = { DB_DRIVER: "pg", NEON_LOCAL_HOST: "x" };
    assert.equal(resolvePoolConfig({ ...base, DB_POOL_MAX: "20" })?.max, 20);
    assert.equal(resolvePoolConfig({ ...base, DB_POOL_MAX: "9999" })?.max, 10);
    assert.equal(resolvePoolConfig({ ...base, DB_POOL_MAX: "abc" })?.max, 10);
  });
});
