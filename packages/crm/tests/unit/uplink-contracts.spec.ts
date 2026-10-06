import test from "node:test";
import assert from "node:assert/strict";
import { assertUplinkFixtureTarget, UPLINK_FIXTURE_WORKSPACES, adapterRequested, assertAdapterAvailable, UplinkAdapterUnavailableError } from "../../src/lib/platform/uplink-contracts";

test("fixture set is the four synthetic offer/workspace rows", () => {
  assert.deepEqual(UPLINK_FIXTURE_WORKSPACES.map((f) => f.offer), [
    "personal-line", "business-front-office", "agency-parent", "agency-child",
  ]);
  assert.equal(new Set(UPLINK_FIXTURE_WORKSPACES.map((f) => f.slug)).size, 4);
});

test("fixture command requires explicit opt-in and loopback in non-production", () => {
  assert.throws(() => assertUplinkFixtureTarget({}), /UPLINK_FIXTURES=enabled/);
  assert.throws(() => assertUplinkFixtureTarget({ UPLINK_FIXTURES: "enabled" }), /DB_DRIVER=pg/);
  assert.throws(() => assertUplinkFixtureTarget({
    UPLINK_FIXTURES: "enabled", DB_DRIVER: "pg", DATABASE_URL: "postgres://hosted-db/app",
    PLATFORM_APP_URL: "http://localhost:3000", NODE_ENV: "test",
  }), /loopback/);
  assert.doesNotThrow(() => assertUplinkFixtureTarget({
    UPLINK_FIXTURES: "enabled", DB_DRIVER: "pg", DATABASE_URL: "postgres://localhost/app",
    PLATFORM_APP_URL: "http://localhost:3000", NODE_ENV: "test",
  }));
});

test("production fixture command accepts only the named staging app and database", () => {
  const base = {
    UPLINK_FIXTURES: "enabled", DB_DRIVER: "pg", UPLINK_FIXTURE_TARGET: "staging", NODE_ENV: "production",
    DATABASE_URL: "postgres://uplink-db/app", PLATFORM_APP_URL: "https://build.uplink.epic.dm",
  };
  assert.doesNotThrow(() => assertUplinkFixtureTarget(base));
  assert.throws(() => assertUplinkFixtureTarget({ ...base, PLATFORM_APP_URL: "https://uplink.epic.dm" }));
});

test("Chatwoot and EPIC voice default off; no live adapter can be invoked", () => {
  for (const kind of ["chatwoot", "epicVoice"] as const) {
    assert.equal(adapterRequested(kind, {}), false);
    assert.throws(() => assertAdapterAvailable(kind, {}), UplinkAdapterUnavailableError);
    const key = kind === "chatwoot" ? "UPLINK_CHATWOOT_ENABLED" : "UPLINK_EPIC_VOICE_ENABLED";
    assert.equal(adapterRequested(kind, { [key]: "true" }), true);
    assert.throws(() => assertAdapterAvailable(kind, { [key]: "true" }), /not_implemented/);
  }
});
