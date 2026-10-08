import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildEmbedTurnUrl, resolveEmbedOrigin } from "../../../src/lib/agents/public-embed-resolution";

const platform = { appUrl: "https://uplink.epic.dm", workspaceBaseDomain: "uplink.epic.dm" };
const origin = (host: string | null, forwardedHost: string | null = null, forwardedProto: string | null = "https") =>
  resolveEmbedOrigin({ host, forwardedHost, forwardedProto, ...platform });

describe("embed.js turn origin", () => {
  test("REGRESSION: the container's internal bind address never reaches the script", () => {
    // v4.34-v4.38 produced https://0.0.0.0:3000 here (request.url inside the container).
    for (const internal of ["0.0.0.0:3000", "0.0.0.0", "localhost:3000", "127.0.0.1:3000", "app", "10.0.0.5:3000"]) {
      assert.equal(origin(internal), "https://uplink.epic.dm", internal);
    }
  });

  test("the host the proxy passes through is used when it is one of the platform's hosts", () => {
    assert.equal(origin("uplink.epic.dm"), "https://uplink.epic.dm");
    assert.equal(origin("uplinks-workspace-4816.uplink.epic.dm"), "https://uplinks-workspace-4816.uplink.epic.dm");
    assert.equal(origin("0.0.0.0:3000", "uplink.epic.dm"), "https://uplink.epic.dm");
    assert.equal(origin("0.0.0.0:3000", "uplink.epic.dm, evil.example"), "https://uplink.epic.dm");
  });

  test("a spoofed or foreign Host cannot redirect visitors' messages to another origin", () => {
    for (const evil of [
      "evil.example",
      "uplink.epic.dm.evil.example",
      "evil-uplink.epic.dm.attacker.io",
      "notuplink.epic.dm",
      "uplink.epic.dm@evil.example",
      "uplink.epic.dm:3000",
      "",
    ]) {
      assert.equal(origin(evil), "https://uplink.epic.dm", evil);
    }
    assert.equal(origin(null), "https://uplink.epic.dm");
  });

  test("protocol comes from X-Forwarded-Proto and defaults to https", () => {
    assert.equal(origin("uplink.epic.dm", null, "http"), "http://uplink.epic.dm");
    assert.equal(origin("uplink.epic.dm", null, null), "https://uplink.epic.dm");
    assert.equal(origin("uplink.epic.dm", null, "javascript"), "https://uplink.epic.dm");
  });

  test("the resulting turn URL is the public one", () => {
    assert.equal(
      buildEmbedTurnUrl(origin("0.0.0.0:3000", "uplink.epic.dm"), "uplinks-workspace-4816", "default"),
      "https://uplink.epic.dm/api/v1/public/agent/uplinks-workspace-4816--default/turn",
    );
  });

  test("the route derives the origin from the proxy headers, not from request.url", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../src/app/api/v1/public/agent/[slug]/embed.js/route.ts"),
      "utf8",
    );
    assert.match(source, /resolveEmbedOrigin\(\{/);
    assert.match(source, /request\.headers\.get\("x-forwarded-host"\)/);
    assert.doesNotMatch(source, /url\.host|url\.protocol|new URL\(request\.url\)/);
  });
});
