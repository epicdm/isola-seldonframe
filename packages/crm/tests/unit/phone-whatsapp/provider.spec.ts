import assert from "node:assert/strict";
import test from "node:test";

import { makeEvidenceProvider } from "../../../src/lib/phone-whatsapp/evidence-provider";
import { LINK, evidence } from "./fixtures";

const jsonRes = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const TOKEN = `fixture-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const mk = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => makeEvidenceProvider({ baseUrl: "http://adapter.internal:8787", token: TOKEN, fetchImpl, ...over });

test("sends exactly one authenticated GET for the linked ids and returns the evidence (positive control)", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const p = mk((async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return jsonRes(evidence());
  }) as unknown as typeof fetch);
  const r = await p(LINK);
  assert.equal(r.kind, "evidence");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `http://adapter.internal:8787/v1/lines/${LINK.phoneNumberId}?waba=${LINK.wabaId}`);
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
});

test("not configured (no URL or no token): not_configured and NO request is made", async () => {
  let called = 0;
  const f = (async () => { called++; return jsonRes({}); }) as unknown as typeof fetch;
  assert.deepEqual(await makeEvidenceProvider({ baseUrl: null, token: TOKEN, fetchImpl: f })(LINK), { kind: "not_configured" });
  assert.deepEqual(await makeEvidenceProvider({ baseUrl: "http://x", token: "", fetchImpl: f })(LINK), { kind: "not_configured" });
  assert.equal(called, 0);
});

test("HTTP error, non-JSON, timeout and network failure each become a failed value with a specific reason; the token never leaks", async () => {
  const cases: Array<[string, typeof fetch, RegExp]> = [
    ["http", (async () => jsonRes({}, 502)) as unknown as typeof fetch, /HTTP 502/],
    ["nonjson", (async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }) as unknown as Response) as unknown as typeof fetch, /not JSON/],
    ["timeout", (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch, /did not answer in time/],
    ["network", (async () => { throw new Error(`connect refused with ${TOKEN}`); }) as unknown as typeof fetch, /could not be reached/],
  ];
  for (const [name, f, re] of cases) {
    const r = await mk(f)(LINK);
    assert.equal(r.kind, "failed", name);
    assert.match((r as { error: string }).error, re, name);
    assert.ok(!JSON.stringify(r).includes(TOKEN), `${name}: token leaked`);
  }
});

test("a reply about a DIFFERENT number or WABA is refused, never shown as this line's facts", async () => {
  const other = await mk((async () => jsonRes(evidence({ phoneNumberId: "999888777666555" }))) as unknown as typeof fetch)(LINK);
  assert.equal(other.kind, "failed");
  assert.match((other as { error: string }).error, /different number/);
  const otherWaba = await mk((async () => jsonRes(evidence({ wabaId: "123456789012345" }))) as unknown as typeof fetch)(LINK);
  assert.equal(otherWaba.kind, "failed");
});

test("malformed evidence (wrong schema, missing blocks, bad time) is refused", async () => {
  for (const bad of [{ ...evidence(), schema: "line-evidence/v0" }, { ...evidence(), meta: undefined }, { ...evidence(), observedAt: "not a time" }, null, "str"]) {
    const r = await mk((async () => jsonRes(bad)) as unknown as typeof fetch)(LINK);
    assert.equal(r.kind, "failed");
  }
});

test("a non-http evidence URL is refused without a request", async () => {
  let called = 0;
  const r = await makeEvidenceProvider({ baseUrl: "file:///etc/passwd", token: TOKEN, fetchImpl: (async () => { called++; return jsonRes({}); }) as unknown as typeof fetch })(LINK);
  assert.equal(r.kind, "failed");
  assert.equal(called, 0);
});
