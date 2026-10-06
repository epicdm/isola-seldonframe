// Run: node --import tsx --test tests/unit/http/app-hosts.spec.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseAppHosts, extraAppHosts, primaryAppHost } from "../../../src/lib/http/app-hosts";

describe("APP_HOSTS", () => {
  test("unset keeps vendor behaviour (no extra hosts, no primary)", () => {
    assert.deepEqual(extraAppHosts({}), []);
    assert.equal(primaryAppHost({}), null);
  });
  test("positive control: list is parsed, lowercased, scheme/port/path stripped", () => {
    assert.deepEqual(parseAppHosts(" Agents.Epic.dm , https://ops.example.com:8443/x "), ["agents.epic.dm", "ops.example.com"]);
    assert.equal(primaryAppHost({ APP_HOSTS: "agents.epic.dm,b.test" }), "agents.epic.dm");
  });
  test("garbage entries are dropped (no wildcard / injection)", () => {
    assert.deepEqual(parseAppHosts("*.evil.com,a b,,-x.com,ok.test"), ["ok.test"]);
  });
});
