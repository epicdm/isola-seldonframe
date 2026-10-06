import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkspaceAdminRedirectUrl,
  canonicalAppOrigin,
  extraAppHosts,
  parseAppHosts,
  primaryAppHost,
} from "../../../src/lib/http/app-hosts";
import { resolveAppHostRedirectTarget } from "../../../src/lib/auth/app-host-redirect";

describe("Uplink application hosts", () => {
  test("APP_HOSTS normalization is shared and strips scheme, port, and path", () => {
    assert.deepEqual(parseAppHosts(" Agents.Epic.dm , https://ops.example.com:8443/x "), [
      "agents.epic.dm",
      "ops.example.com",
    ]);
    assert.deepEqual(parseAppHosts("*.evil.test, bad host,https://user:pw@no.test,ok.test"), ["ok.test"]);
    assert.deepEqual(extraAppHosts({ APP_HOSTS: "agents.epic.dm,agents.epic.dm" }), ["agents.epic.dm"]);
  });

  test("canonical origin requires configured auth and public origins to agree", () => {
    const env = {
      NEXT_PUBLIC_APP_URL: "https://uplink.epic.dm",
      AUTH_URL: "https://uplink.epic.dm/",
    };
    assert.equal(canonicalAppOrigin(env), "https://uplink.epic.dm");
    assert.equal(primaryAppHost(env), "uplink.epic.dm");
    assert.throws(
      () => canonicalAppOrigin({ ...env, AUTH_URL: "https://wrong.example" }),
      /same canonical origin/,
    );
    assert.throws(() => canonicalAppOrigin({ NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }), /HTTP\(S\)/);
  });

  test("secondary app aliases redirect auth to canonical host and preserve callback query", () => {
    assert.equal(
      resolveAppHostRedirectTarget({
        requestHost: "ops.uplink.epic.dm",
        appOrigin: "https://uplink.epic.dm",
        path: "/signup",
        search: "?callbackUrl=%2Fdashboard",
      }),
      "https://uplink.epic.dm/signup?callbackUrl=%2Fdashboard",
    );
    assert.equal(
      resolveAppHostRedirectTarget({
        requestHost: "uplink.epic.dm",
        appOrigin: "https://uplink.epic.dm",
        path: "/signup",
        search: "",
      }),
      null,
    );
  });

  test("workspace admin redirect uses the canonical app URL, never vendor host", () => {
    const target = buildWorkspaceAdminRedirectUrl(
      "synthetic-org",
      "/dashboard",
      "?from=fixture",
      { NEXT_PUBLIC_APP_URL: "https://uplink.epic.dm" },
    );
    assert.equal(target?.origin, "https://uplink.epic.dm");
    assert.equal(target?.pathname, "/switch-workspace");
    assert.equal(target?.searchParams.get("to"), "synthetic-org");
    assert.equal(target?.searchParams.get("next"), "/dashboard?from=fixture");
  });
});
