import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extraAppHosts, parseAppHosts, primaryAppHost } from "../../../src/lib/http/app-hosts";

describe("APP_HOSTS", () => {
  test("unset preserves the vendor fallback", () => {
    assert.deepEqual(extraAppHosts({}), []);
    assert.equal(primaryAppHost({}), null);
  });

  test("normalizes configured public origins to hostnames", () => {
    assert.deepEqual(
      parseAppHosts(" https://Uplink.Epic.dm:443/path, clients.uplink.epic.dm "),
      ["uplink.epic.dm", "clients.uplink.epic.dm"],
    );
    assert.equal(primaryAppHost({ APP_HOSTS: "uplink.epic.dm,clients.uplink.epic.dm" }), "uplink.epic.dm");
  });

  test("drops malformed or wildcard entries", () => {
    assert.deepEqual(parseAppHosts("*.evil.com,https://bad host,x/y,-invalid.test,ok.example"), ["ok.example"]);
  });
});
