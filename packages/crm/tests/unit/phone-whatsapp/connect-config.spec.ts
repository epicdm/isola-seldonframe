// Fail-closed configuration and the same-origin rule. Each refusal has its positive twin in the same test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { REAL_GRAPH_BASE, isConnectEnabled, loadConnectConfig } from "../../../src/lib/phone-whatsapp/connect/config";
import { sameOrigin } from "../../../src/lib/phone-whatsapp/connect/origin";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const FULL = { PHONE_CONNECT_ENABLED_ORGS: A, META_APP_ID: "990000000000001", META_APP_SECRET: "fictional", META_ES_CONFIG_ID: "990000000000009", PHONE_CONNECT_EPIC_WABA_IDS: "900000000000777", PHONE_CONNECT_PROTECTED_PHONE_IDS: "900000000000888" };

describe("loadConnectConfig", () => {
  test("default off: nothing configured enables nobody (twin: the full config enables the listed workspace)", () => {
    assert.deepEqual(loadConnectConfig(A, {}), { ok: false, reason: "disabled" });
    assert.equal(loadConnectConfig(A, FULL).ok, true);
  });
  test("a workspace that is not listed is disabled, even with a complete config", () => {
    assert.deepEqual(loadConnectConfig(B, FULL), { ok: false, reason: "disabled" });
    assert.equal(isConnectEnabled(B, FULL), false);
    assert.equal(isConnectEnabled(A, FULL), true);
  });
  for (const k of ["META_APP_ID", "META_APP_SECRET", "META_ES_CONFIG_ID"] as const) {
    test(`unconfigured without ${k} (no Connect button that cannot work)`, () => {
      assert.deepEqual(loadConnectConfig(A, { ...FULL, [k]: "" }), { ok: false, reason: "unconfigured" });
    });
  }
  test("non-numeric app id or configuration id is unconfigured", () => {
    assert.equal(loadConnectConfig(A, { ...FULL, META_APP_ID: "abc" }).ok, false);
    assert.equal(loadConnectConfig(A, { ...FULL, META_ES_CONFIG_ID: "12 34" }).ok, false);
  });
  test("a custom Graph base WITHOUT test mode refuses to configure (a customer token must never be sent elsewhere)", () => {
    assert.deepEqual(loadConnectConfig(A, { ...FULL, META_GRAPH_BASE: "http://evil.test" }), { ok: false, reason: "unsafe_graph_base" });
  });
  test("with test mode the override is honoured; without an override the real base is used", () => {
    const t = loadConnectConfig(A, { ...FULL, PHONE_CONNECT_TEST_MODE: "1", META_GRAPH_BASE: "http://sink:9100/" });
    assert.equal(t.ok && t.graphBase, "http://sink:9100");
    assert.equal(t.ok && t.testMode, true);
    const p = loadConnectConfig(A, FULL);
    assert.equal(p.ok && p.graphBase, REAL_GRAPH_BASE);
    assert.equal(p.ok && p.testMode, false);
  });
  test("test mode alone does not change the base; only an exact '1' turns it on", () => {
    const t = loadConnectConfig(A, { ...FULL, PHONE_CONNECT_TEST_MODE: "true" });
    assert.equal(t.ok && t.testMode, false);
  });
  test("the deny-lists come from the environment (none are in the repository) and are exposed in the config", () => {
    const c = loadConnectConfig(A, { ...FULL, PHONE_CONNECT_PROTECTED_PHONE_IDS: "900000000000888, 111111, x", PHONE_CONNECT_EPIC_WABA_IDS: "900000000000777,900000000000778" });
    assert.ok(c.ok);
    if (c.ok) {
      assert.deepEqual([...c.protectedPhoneIds], ["900000000000888", "111111"], "malformed entries are dropped");
      assert.deepEqual([...c.epicWabaIds], ["900000000000777", "900000000000778"]);
    }
  });
  test("outside test mode an EMPTY deny-list refuses to configure (an empty list would allow binding EPIC's own assets); twin: present lists configure", () => {
    for (const k of ["PHONE_CONNECT_EPIC_WABA_IDS", "PHONE_CONNECT_PROTECTED_PHONE_IDS"] as const) {
      assert.deepEqual(loadConnectConfig(A, { ...FULL, [k]: "" }), { ok: false, reason: "missing_denylist" });
      assert.deepEqual(loadConnectConfig(A, { ...FULL, [k]: "not-an-id" }), { ok: false, reason: "missing_denylist" });
    }
    assert.equal(loadConnectConfig(A, FULL).ok, true);
  });
  test("test mode (fictional assets) may run without deny-lists", () => {
    const { PHONE_CONNECT_EPIC_WABA_IDS: _a, PHONE_CONNECT_PROTECTED_PHONE_IDS: _b, ...rest } = FULL;
    assert.equal(loadConnectConfig(A, { ...rest, PHONE_CONNECT_TEST_MODE: "1" }).ok, true);
    assert.equal(loadConnectConfig(A, rest).ok, false);
  });
});

describe("sameOrigin", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
  test("same host passes; a different site is refused (twin in the same test)", () => {
    assert.equal(sameOrigin(h({ origin: "https://uplink.epic.dm", host: "uplink.epic.dm" })), true);
    assert.equal(sameOrigin(h({ origin: "https://evil.example", host: "uplink.epic.dm" })), false);
  });
  test("a missing Origin is refused", () => {
    assert.equal(sameOrigin(h({ host: "uplink.epic.dm" })), false);
  });
  test("behind a proxy the forwarded host is what the browser used", () => {
    assert.equal(sameOrigin(h({ origin: "https://uplink.epic.dm", host: "10.0.0.5:3000", "x-forwarded-host": "uplink.epic.dm" })), true);
    assert.equal(sameOrigin(h({ origin: "https://uplink.epic.dm", host: "uplink.epic.dm", "x-forwarded-host": "other.example" })), false);
  });
  test("a malformed Origin is refused, not thrown", () => {
    assert.equal(sameOrigin(h({ origin: "not a url", host: "uplink.epic.dm" })), false);
  });
});
