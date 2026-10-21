// EPIC 2026-10-21 (Lane A) — PATH test for the workspace-subdomain intake and booking rewrites. It runs the real
// exported proxy() on a real NextRequest. The only seam is global fetch, which stands in for the proxy's own
// /api/v1/public/domain lookup:
//   - "403" reproduces production today: from inside the container the public-hostname lookup returns 403
//     "Forbidden" and the proxy falls back to hard-coded defaults;
//   - "ok" is a working lookup that returns EPIC's real defaults (bookingSlug setup-help, formSlug pl-staff-test-oct15).
// Asserts: bare /intake and /forms reach the workspace-default route, never a guessed slug or the staff form;
// every existing explicit form URL is unchanged; /book is unchanged with the internal-lookup gate OFF. The gate-ON
// case is the positive control: it proves the gate, and nothing else, is what keeps /book unchanged.
// Run: node --import tsx --test tests/unit/forms/intake-default-proxy-path.spec.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const HOST = "uplinks-workspace-4816.uplink.epic.dm";
const ORG = "uplinks-workspace-4816";
const ALIAS = `/workspace-intake/uplinks-workspace-4816`;

const ENV_KEYS = ["PLATFORM_NAME", "PLATFORM_APP_URL", "NEXT_PUBLIC_APP_URL", "APP_HOSTS", "WORKSPACE_BASE_DOMAIN", "UPLINK_PROXY_INTERNAL_DOMAIN_LOOKUP", "UPLINK_PROXY_INTERNAL_ORIGIN", "PORT"] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let lookupMode: "403" | "ok" = "403";
const lookups: string[] = [];

type Proxy = typeof import("../../../src/proxy").proxy;
let proxy: Proxy;

function target(res: Response | null | undefined): string {
  assert.ok(res, "proxy returned no response");
  const rewrite = res.headers.get("x-middleware-rewrite");
  if (rewrite) return new URL(rewrite).pathname;
  if (res.headers.get("x-middleware-next") === "1") return "(next)";
  return `(status ${res.status} location ${res.headers.get("location")})`;
}

async function hit(path: string) {
  return target(await proxy(new NextRequest(`https://${HOST}${path}`, { headers: { host: HOST } }), undefined as never));
}

describe("workspace subdomain intake and booking rewrites (real proxy, fetch seam)", () => {
  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PLATFORM_NAME = "Uplink";
    process.env.PLATFORM_APP_URL = "https://uplink.epic.dm";
    process.env.NEXT_PUBLIC_APP_URL = "https://uplink.epic.dm";
    process.env.APP_HOSTS = "uplink.epic.dm";
    process.env.WORKSPACE_BASE_DOMAIN = "uplink.epic.dm";
    delete process.env.UPLINK_PROXY_INTERNAL_DOMAIN_LOOKUP;
    delete process.env.UPLINK_PROXY_INTERNAL_ORIGIN;
    delete process.env.PORT;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      lookups.push(url);
      if (!url.includes("/api/v1/public/domain")) throw new Error(`unexpected fetch ${url}`);
      if (lookupMode === "403") return new Response("Forbidden", { status: 403 });
      return Response.json({ ok: true, org: { id: "2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8", slug: ORG, defaults: { landingSlug: "home", bookingSlug: "setup-help", formSlug: "pl-staff-test-oct15" } } });
    }) as typeof fetch;
    ({ proxy } = await import("../../../src/proxy"));
  });

  after(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("production today (lookup 403): bare /intake and /forms reach the workspace-default route, not a guessed 'intake' slug", async () => {
    lookupMode = "403";
    assert.equal(await hit("/intake"), ALIAS);
    assert.equal(await hit("/forms"), ALIAS);
  });

  it("a working lookup: bare /intake still reaches the workspace-default route, never the lookup's staff form", async () => {
    lookupMode = "ok";
    assert.equal(await hit("/intake"), ALIAS);
    assert.notEqual(await hit("/intake"), `/forms/${ORG}/pl-staff-test-oct15`);
  });

  for (const mode of ["403", "ok"] as const) {
    it(`existing explicit form URLs are unchanged (lookup ${mode})`, async () => {
      lookupMode = mode;
      assert.equal(await hit("/intake/personal-line-intake"), `/forms/${ORG}/personal-line-intake`);
      assert.equal(await hit("/forms/personal-line-intake"), `/forms/${ORG}/personal-line-intake`);
      assert.equal(await hit(`/forms/${ORG}/personal-line-intake`), "(next)");
      assert.equal(await hit("/intake/pl-staff-test-oct15"), `/forms/${ORG}/pl-staff-test-oct15`);
    });
  }

  it("gate OFF (default): the lookup still goes to the request origin and /book resolves exactly as today", async () => {
    lookupMode = "403";
    lookups.length = 0;
    assert.equal(await hit("/book"), `/book/${ORG}/default`);
    assert.equal(await hit("/book/setup-help"), `/book/${ORG}/setup-help`);
    assert.equal(await hit("/"), `/s/${ORG}/home`);
    assert.ok(lookups.length > 0, "control: the lookup was attempted");
    assert.ok(lookups.every((u) => u.startsWith(`https://${HOST}/api/v1/public/domain`)), lookups.join(" "));
  });

  it("gate ON (positive control): the lookup moves to the internal origin, and that alone changes /book", async () => {
    process.env.UPLINK_PROXY_INTERNAL_DOMAIN_LOOKUP = "1";
    try {
      lookupMode = "ok";
      lookups.length = 0;
      assert.equal(await hit("/book"), `/book/${ORG}/setup-help`);
      assert.ok(lookups.length > 0 && lookups.every((u) => u.startsWith("http://127.0.0.1:3000/api/v1/public/domain")), lookups.join(" "));
      assert.equal(await hit("/intake"), ALIAS);
    } finally {
      delete process.env.UPLINK_PROXY_INTERNAL_DOMAIN_LOOKUP;
    }
  });
});
