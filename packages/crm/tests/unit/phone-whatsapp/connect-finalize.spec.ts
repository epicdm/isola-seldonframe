// The journey, through the orchestration (not the pieces): start -> finalize -> bound line, and every way it can stop half-way.
// Every "did not happen" assertion has a positive twin in the same harness (the happy path binds and registers, so the harness CAN).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  finalizeConnect,
  hashNonce,
  startConnect,
  type Consent,
  type ConnectStore,
  type ConnectionStatus,
  type FinalizeDeps,
} from "../../../src/lib/phone-whatsapp/connect/finalize";
import type { DebugToken, WabaPhone } from "../../../src/lib/phone-whatsapp/connect/verify-assets";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const WABA = "900000000000001";
const PHONE = "900000000000002";
const TOKEN = ["fixture", "customer", "bearer", "0001"].join("-"); // fictional test value, not a credential

class Definite extends Error {}

type Over = {
  debug?: Partial<DebugToken>; phones?: WabaPhone[];
  registerFails?: "none" | "definite" | "unknown"; failActivate?: boolean; exchangeFails?: boolean; failSetRegistered?: boolean;
};

function harness(over: Over = {}) {
  const attempts = new Map<string, { orgId: string; userId: string; expiresAt: Date; consent: Consent }>();
  const lines: Array<{ orgId: string; phoneNumberId: string; wabaId: string; label: string | null }> = [];
  const conns = new Map<string, { orgId: string; status: ConnectionStatus; wabaId: string; hasPin: boolean; consent?: Consent; tokenEnc?: string; pinEnc?: string; reason?: string }>();
  const calls: string[] = [];
  const cfg = { ...over };
  const k = (org: string, phone: string) => `${org}/${phone}`;
  const store: ConnectStore = {
    async putAttempt(a) { attempts.set(a.nonceHash, { orgId: a.orgId, userId: a.userId, expiresAt: a.expiresAt, consent: a.consent }); },
    async consumeAttempt(a) {
      const r = attempts.get(a.nonceHash);
      if (!r || r.orgId !== a.orgId || r.userId !== a.userId || r.expiresAt <= a.now) return null;
      attempts.delete(a.nonceHash);
      return r.consent;
    },
    async claimants(id) {
      const s = new Set<string>();
      for (const l of lines) if (l.phoneNumberId === id) s.add(l.orgId);
      for (const [key, c] of conns) if (key.endsWith(`/${id}`) && c.status !== "failed") s.add(c.orgId);
      return [...s];
    },
    async getConnection(a) { const c = conns.get(k(a.orgId, a.phoneNumberId)); return c ? { status: c.status, wabaId: c.wabaId, hasPin: c.hasPin } : null; },
    async savePending(a) {
      const key = k(a.orgId, a.phoneNumberId); const c = conns.get(key);
      conns.set(key, {
        orgId: a.orgId, wabaId: a.wabaId, consent: a.consent, tokenEnc: a.tokenEnc, pinEnc: a.pinEnc ?? c?.pinEnc, hasPin: !!(a.pinEnc ?? c?.pinEnc),
        status: c && (c.status === "registered" || c.status === "active") ? c.status : "pending",
      });
    },
    async setStatus(a) {
      if (a.status === "registered" && cfg.failSetRegistered) throw new Error("db");
      const key = k(a.orgId, a.phoneNumberId); const c = conns.get(key)!; c.status = a.status; if (a.reason) c.reason = a.reason;
    },
    async activate(a) {
      if (cfg.failActivate) throw new Error("db");
      lines.push({ orgId: a.orgId, phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, label: a.label });
      conns.get(k(a.orgId, a.phoneNumberId))!.status = "active";
    },
  };
  let clock = new Date("2026-10-18T10:00:00Z");
  const deps: FinalizeDeps = {
    store,
    graph: {
      async debugToken() { calls.push("debug"); return { isValid: true, appId: "APP1", scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], wabaTargets: [WABA], ...over.debug }; },
      async listWabaPhones() { calls.push("list"); return over.phones ?? [{ id: PHONE, displayNumber: "+1 555 0100", verifiedName: "Test Co", platformType: "CLOUD_API", isOnBizApp: false }]; },
    },
    async exchangeCode() { calls.push("exchange"); if (cfg.exchangeFails) throw new Error("x"); return TOKEN; },
    async register() {
      calls.push("register");
      if (cfg.registerFails === "definite") throw new Definite("4xx");
      if (cfg.registerFails === "unknown") throw new Error("timeout");
    },
    isDefiniteFailure: (e) => e instanceof Definite,
    encrypt: (v) => `enc(${Buffer.from(v).toString("base64")})`,
    ourAppId: "APP1",
    epicWabaIds: new Set(["900000000000777"]),
    protectedPhoneIds: new Set(["900000000000888"]),
    now: () => clock,
  };
  const registers = () => calls.filter((c) => c === "register").length;
  return { deps, lines, conns, calls, attempts, cfg, registers, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

async function begin(h: ReturnType<typeof harness>, orgId = A, userId = "user-1") {
  const s = await startConnect({ orgId, userId, consentAccepted: true }, h.deps);
  assert.equal(s.ok, true);
  return (s as { ok: true; nonce: string }).nonce;
}
const claim = (nonce: string, o: Record<string, unknown> = {}) => ({ orgId: A, userId: "user-1", nonce, code: "code-1", wabaId: WABA, phoneNumberId: PHONE, ...o });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

describe("connect journey", () => {
  test("positive control: consent -> start -> finalize binds the number to the workspace and activates it", async () => {
    const h = harness();
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual(r, { ok: true, displayNumber: "+1 555 0100", phoneNumberId: PHONE, resumed: false });
    assert.deepEqual(h.lines.map((l) => [l.orgId, l.phoneNumberId, l.wabaId]), [[A, PHONE, WABA]]);
    assert.deepEqual(h.calls, ["exchange", "debug", "list", "register"]);
    assert.equal(h.conns.get(`${A}/${PHONE}`)?.status, "active");
  });

  test("the consent record survives into the connection record (it must outlive the consumed attempt)", async () => {
    const h = harness();
    await finalizeConnect(claim(await begin(h)), h.deps);
    assert.equal(h.attempts.size, 0);
    const c = h.conns.get(`${A}/${PHONE}`)!.consent!;
    assert.deepEqual([c.userId, /^whatsapp-connect-/.test(c.termsVersion)], ["user-1", true]);
  });

  test("start refuses without recorded consent", async () => {
    const h = harness();
    assert.deepEqual(await startConnect({ orgId: A, userId: "user-1", consentAccepted: false }, h.deps), { ok: false, code: "forbidden" });
    assert.equal(h.attempts.size, 0);
    await begin(h);
    assert.equal(h.attempts.size, 1);
  });

  test("the nonce is stored hashed, never in clear", async () => {
    const h = harness();
    const n = await begin(h);
    assert.equal(h.attempts.has(n), false);
    assert.equal(h.attempts.has(hashNonce(n)), true);
  });

  test("replay: a spent nonce is refused BEFORE any Meta call (twin: first use did call Meta)", async () => {
    const h = harness();
    const n = await begin(h);
    assert.equal((await finalizeConnect(claim(n), h.deps)).ok, true);
    const before = h.calls.length;
    assert.ok(before > 0);
    assert.equal(code(await finalizeConnect(claim(n), h.deps)), "attempt_invalid");
    assert.equal(h.calls.length, before);
  });

  test("cross-workspace and cross-user: a nonce minted for A/user-1 cannot finalize for B or another user (twin: A/user-1 works)", async () => {
    const h = harness();
    const n = await begin(h);
    assert.equal((await finalizeConnect(claim(n, { orgId: B }), h.deps)).ok, false);
    assert.equal((await finalizeConnect(claim(n, { userId: "user-2" }), h.deps)).ok, false);
    assert.equal(h.lines.length, 0);
    assert.equal((await finalizeConnect(claim(n), h.deps)).ok, true);
  });

  test("expiry: a nonce older than the TTL is refused (twin: within TTL works)", async () => {
    const h = harness();
    const fresh = await begin(h);
    h.advance(5 * 60_000);
    assert.equal((await finalizeConnect(claim(fresh), h.deps)).ok, true);
    const stale = await begin(h, A, "user-1");
    h.advance(16 * 60_000);
    assert.equal(code(await finalizeConnect(claim(stale), h.deps)), "attempt_invalid");
  });

  test("forged browser hint: claiming a phone Meta does not list binds NOTHING and registers NOTHING", async () => {
    const h = harness();
    const r = await finalizeConnect(claim(await begin(h), { phoneNumberId: "900000000000099" }), h.deps);
    assert.equal(code(r), "phone_not_on_waba");
    assert.deepEqual([h.lines.length, h.conns.size, h.registers()], [0, 0, 0]);
  });

  test("a token for another app, or EPIC's WABA, binds nothing", async () => {
    const h1 = harness({ debug: { appId: "OTHER" } });
    assert.deepEqual([code(await finalizeConnect(claim(await begin(h1)), h1.deps)), h1.lines.length], ["wrong_app", 0]);
    const h2 = harness();
    assert.deepEqual([code(await finalizeConnect(claim(await begin(h2), { wabaId: "900000000000777" }), h2.deps)), h2.lines.length], ["epic_owned_waba", 0]);
  });

  test("coexistence number is refused here, nothing bound, nothing registered", async () => {
    const h = harness({ phones: [{ id: PHONE, displayNumber: "+1", verifiedName: "x", platformType: "CLOUD_API", isOnBizApp: true }] });
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([code(r), h.lines.length, h.registers()], ["coexistence_not_supported_here", 0, 0]);
  });

  test("one number, one workspace: B cannot take a number A holds, nor one A has half-connected", async () => {
    const h = harness();
    assert.equal((await finalizeConnect(claim(await begin(h)), h.deps)).ok, true);
    const nb = await begin(h, B, "user-b");
    assert.equal(code(await finalizeConnect(claim(nb, { orgId: B, userId: "user-b" }), h.deps)), "already_bound");
    const h2 = harness({ failActivate: true }); // A registers but cannot bind: the number is still A's, unfinished
    await finalizeConnect(claim(await begin(h2)), h2.deps);
    assert.equal(h2.lines.length, 0);
    const nb2 = await begin(h2, B, "user-b");
    assert.equal(code(await finalizeConnect(claim(nb2, { orgId: B, userId: "user-b" }), h2.deps)), "already_bound");
  });

  test("the token and PIN never appear in any result, and only encrypted forms are stored", async () => {
    const h = harness({ registerFails: "definite" });
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
    const c = h.conns.get(`${A}/${PHONE}`)!;
    assert.equal(c.tokenEnc!.includes(TOKEN), false);
    assert.equal(c.tokenEnc!.startsWith("enc("), true); // control: the encrypt port was used
    assert.match(Buffer.from(c.pinEnc!.slice(4, -1), "base64").toString(), /^\d{6}$/);
  });

  test("code exchange failure reports token_invalid and binds nothing; malformed input is refused before the nonce is spent", async () => {
    const h = harness({ exchangeFails: true });
    assert.deepEqual([code(await finalizeConnect(claim(await begin(h)), h.deps)), h.lines.length], ["token_invalid", 0]);
    const g = harness();
    const n = await begin(g);
    assert.equal(code(await finalizeConnect(claim(n, { code: 42 }), g.deps)), "bad_input");
    assert.equal((await finalizeConnect(claim(n), g.deps)).ok, true);
  });
});

describe("partial completion: registered at Meta, not (or not provably) bound here", () => {
  test("activation fails AFTER Meta registered: reported as not connected; recoverable state is 'registered'", async () => {
    const h = harness({ failActivate: true });
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.equal(code(r), "persist_failed");
    assert.equal((r as { message: string }).message.includes("not been undone"), true);
    assert.deepEqual([h.lines.length, h.registers(), h.conns.get(`${A}/${PHONE}`)?.status], [0, 1, "registered"]);
  });

  test("browser closed / retry: the retry finishes the binding and does NOT register a second time (twin: the first run registered once)", async () => {
    const h = harness({ failActivate: true });
    await finalizeConnect(claim(await begin(h)), h.deps);
    assert.equal(h.registers(), 1);
    const pinBefore = h.conns.get(`${A}/${PHONE}`)!.pinEnc;
    h.cfg.failActivate = false;
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual(r, { ok: true, displayNumber: "+1 555 0100", phoneNumberId: PHONE, resumed: true });
    assert.equal(h.registers(), 1, "no second registration");
    assert.equal(h.conns.get(`${A}/${PHONE}`)!.pinEnc, pinBefore, "the PIN that registered the number is kept");
    assert.equal(h.lines.length, 1);
    assert.equal(h.conns.get(`${A}/${PHONE}`)!.status, "active");
  });

  test("registered at Meta but the 'registered' mark could not be saved: reported as not connected; the retry does not register again either", async () => {
    const h = harness({ failSetRegistered: true });
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([code(r), h.registers(), h.conns.get(`${A}/${PHONE}`)?.status], ["persist_failed", 1, "registering"]);
    h.cfg.failSetRegistered = false;
    const r2 = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([code(r2), h.registers(), h.lines.length], ["needs_review", 1, 0]);
  });

  test("outcome unknown (timeout / 5xx): needs_review, state stays 'registering', and a retry never registers again or deregisters", async () => {
    const h = harness({ registerFails: "unknown" });
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([code(r), h.conns.get(`${A}/${PHONE}`)?.status, h.registers(), h.lines.length], ["needs_review", "registering", 1, 0]);
    h.cfg.registerFails = "none"; // even if Meta is healthy again
    const r2 = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([code(r2), h.registers(), h.lines.length], ["needs_review", 1, 0]);
    assert.equal(h.calls.some((c) => /deregister|delete/i.test(c)), false);
  });

  test("Meta explicitly rejects the registration: nothing registered, state 'failed', a fresh attempt may register again (twin: not so for unknown)", async () => {
    const h = harness({ registerFails: "definite" });
    assert.equal(code(await finalizeConnect(claim(await begin(h)), h.deps)), "register_failed");
    assert.equal(h.conns.get(`${A}/${PHONE}`)?.status, "failed");
    h.cfg.registerFails = "none";
    const r2 = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([r2.ok, h.registers(), h.lines.length], [true, 2, 1]);
  });

  test("an active connection is idempotent: connecting again succeeds and registers nothing", async () => {
    const h = harness();
    await finalizeConnect(claim(await begin(h)), h.deps);
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([r.ok, (r as { resumed?: boolean }).resumed, h.registers(), h.lines.length], [true, true, 1, 1]);
  });

  test("a connect that stopped before registration began ('pending') may register on retry (nothing had been sent)", async () => {
    const h = harness();
    h.conns.set(`${A}/${PHONE}`, { orgId: A, status: "pending", wabaId: WABA, hasPin: true });
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.deepEqual([r.ok, h.registers()], [true, 1]);
  });
});
