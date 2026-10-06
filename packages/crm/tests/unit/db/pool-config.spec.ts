import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolvePoolConfig } from "../../../src/db/pool-config";

describe("resolvePoolConfig", () => {
  test("unset and explicit Neon preserve the Neon HTTP driver", () => {
    assert.equal(resolvePoolConfig({}), null);
    assert.equal(resolvePoolConfig({ NEON_LOCAL_HOST: "proxy" }), null);
    assert.equal(resolvePoolConfig({ DB_DRIVER: "neon" }), null);
  });

  test("unknown or unsupported drivers fail instead of silently selecting a driver", () => {
    assert.throws(() => resolvePoolConfig({ DB_DRIVER: "PG" }), /Unsupported DB_DRIVER/);
    assert.throws(() => resolvePoolConfig({ DB_DRIVER: "mysql" }), /Unsupported DB_DRIVER/);
  });

  test("pg config works without NEON_LOCAL_HOST and supplies bounded defaults", () => {
    assert.deepEqual(resolvePoolConfig({ DB_DRIVER: "pg" }), {
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      allowExitOnIdle: true,
    });
  });

  test("valid overrides are applied", () => {
    assert.deepEqual(resolvePoolConfig({
      DB_DRIVER: "pg",
      DB_POOL_MAX: "20",
      DB_POOL_IDLE_MS: "45000",
      DB_POOL_CONNECT_TIMEOUT_MS: "12000",
      DB_STATEMENT_TIMEOUT_MS: "60000",
    }), {
      max: 20,
      idleTimeoutMillis: 45_000,
      connectionTimeoutMillis: 12_000,
      statement_timeout: 60_000,
      allowExitOnIdle: true,
    });
  });

  test("each configured bound is inclusive", () => {
    const config = resolvePoolConfig({
      DB_DRIVER: "pg",
      DB_POOL_MAX: "1",
      DB_POOL_IDLE_MS: "1000",
      DB_POOL_CONNECT_TIMEOUT_MS: "500",
      DB_STATEMENT_TIMEOUT_MS: "1000",
    });
    assert.ok(config);
    assert.equal(config.max, 1);
    assert.equal(config.idleTimeoutMillis, 1_000);
    assert.equal(config.connectionTimeoutMillis, 500);
    assert.equal(config.statement_timeout, 1_000);
  });

  test("invalid, fractional, and out-of-range overrides fail closed", () => {
    for (const [key, value] of [
      ["DB_POOL_MAX", "0"],
      ["DB_POOL_MAX", "51"],
      ["DB_POOL_MAX", "1.5"],
      ["DB_POOL_MAX", "bad"],
      ["DB_POOL_IDLE_MS", "999"],
      ["DB_POOL_IDLE_MS", "600001"],
      ["DB_POOL_CONNECT_TIMEOUT_MS", "499"],
      ["DB_POOL_CONNECT_TIMEOUT_MS", "60001"],
      ["DB_STATEMENT_TIMEOUT_MS", "999"],
      ["DB_STATEMENT_TIMEOUT_MS", "300001"],
    ]) {
      assert.throws(
        () => resolvePoolConfig({ DB_DRIVER: "pg", [key]: value }),
        new RegExp(key),
      );
    }
  });
});
