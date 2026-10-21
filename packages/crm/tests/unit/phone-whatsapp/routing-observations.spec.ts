// The recorded routing observations are EPIC-staff configuration: parsed per workspace + number, fail closed, and reachable by no tenant write path.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

import { routingObservationsFor } from "../../../src/lib/phone-whatsapp/service/routing-observations";

const WS = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER = "bbbbbbbb-0000-4000-8000-0000000000b2";
const PHONE = "900000000000002";
const ok = { workspaceId: WS, phoneNumberId: PHONE, observedAt: "2026-10-21T08:55:00Z", source: "Lane A trace", destination: "PJSIP/1@t", result: "configured_unverified" };

describe("routingObservationsFor", () => {
  test("positive control: a well-formed entry for this workspace and number is returned", () => {
    assert.equal(routingObservationsFor(WS, PHONE, JSON.stringify([ok])).length, 1);
  });
  test("another workspace's entry for the same number is never returned", () => {
    assert.deepEqual(routingObservationsFor(WS, PHONE, JSON.stringify([{ ...ok, workspaceId: OTHER }])), []);
    assert.equal(routingObservationsFor(OTHER, PHONE, JSON.stringify([{ ...ok, workspaceId: OTHER }])).length, 1); // control: it IS that workspace's
  });
  test("malformed config or entries = none (fail closed)", () => {
    assert.deepEqual(routingObservationsFor(WS, PHONE, "{not json"), []);
    assert.deepEqual(routingObservationsFor(WS, PHONE, JSON.stringify({ ...ok })), []);
    assert.deepEqual(routingObservationsFor(WS, PHONE, undefined), []);
    for (const bad of [{ observedAt: "yesterday" }, { source: " " }, { destination: "" }, { result: "healthy" }, { result: "faults" }, { result: "faults", faults: [] }, { result: "faults", faults: [" "] }])
      assert.deepEqual(routingObservationsFor(WS, PHONE, JSON.stringify([{ ...ok, ...bad }])), [], JSON.stringify(bad));
  });
});

describe("edit scope: EPIC staff only", () => {
  const src = join(process.cwd(), "src"); // tests run from packages/crm
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
  walk(src);
  const refs = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(src, f).replace(/\\/g, "/"));

  test("the observations are read ONLY from operator-set server configuration, in one place (positive control: that place is found)", () => {
    assert.deepEqual(refs(/process\.env\.PHONE_ROUTING_OBSERVATIONS_JSON|env\[["']PHONE_ROUTING_OBSERVATIONS_JSON/), ["lib/phone-whatsapp/service/server-wiring.ts"]);
  });
  test("no API route, server action or settings store mentions them", () => {
    const users = refs(/routingObservations|routing-observations/);
    assert.ok(users.includes("lib/phone-whatsapp/service/server-wiring.ts"), "positive control: the scan sees the real reader");
    for (const f of users) {
      assert.ok(!f.startsWith("app/api/"), `${f} is an API route`);
      assert.ok(!/^\s*["']use server["']/m.test(readFileSync(join(src, f), "utf8")), `${f} is a server action`);
      assert.notEqual(f, "lib/phone-whatsapp/service/stores.ts", "the settings store must not read or write observations");
    }
  });
});
