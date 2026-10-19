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
  type SyncOutcome,
  type SyncType,
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
  subscribeFails?: boolean; coex?: boolean; overrideFails?: boolean; syncFails?: "none" | "definite" | "unknown";
};

function harness(over: Over = {}) {
  const attempts = new Map<string, { orgId: string; userId: string; expiresAt: Date; consent: Consent }>();
  const lines: Array<{ orgId: string; phoneNumberId: string; wabaId: string; label: string | null }> = [];
  const conns = new Map<string, { orgId: string; status: ConnectionStatus; wabaId: string; hasPin: boolean; consent?: Consent; tokenEnc?: string; pinEnc?: string; reason?: string; attemptId?: string; syncs?: Partial<Record<SyncType, SyncOutcome>>; binding?: unknown }>();
  const calls: string[] = [];
  const steps: string[] = []; // subscribe / coexistence steps, kept apart so the original call-order assertion is unchanged
  const registeredPins: string[] = [];
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
        orgId: a.orgId, wabaId: a.wabaId, consent: a.consent, tokenEnc: a.tokenEnc, pinEnc: a.pinEnc ?? c?.pinEnc, hasPin: !!(a.pinEnc ?? c?.pinEnc), attemptId: a.attemptId,
        status: c && (c.status === "registered" || c.status === "active") ? c.status : "pending",
      });
    },
    async claimRegistering(a) {
      const c = conns.get(k(a.orgId, a.phoneNumberId));
      if (!c || c.status !== "pending" || c.attemptId !== a.attemptId) return false;
      c.status = "registering"; return true;
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
    async activateCoexistence(a) {
      const c = conns.get(k(a.orgId, a.phoneNumberId))!;
      if (c.status !== "coex_linking") throw new Error("cas");
      lines.push({ orgId: a.orgId, phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, label: a.label });
      c.status = "connected_coexistence"; c.binding = a.binding;
    },
    async getSyncs(a) { return { ...(conns.get(k(a.orgId, a.phoneNumberId))?.syncs ?? {}) }; },
    async recordSync(a) {
      const c = conns.get(k(a.orgId, a.phoneNumberId))!;
      c.syncs = c.syncs ?? {};
      if (c.syncs[a.syncType]) throw new Error("write-once");
      c.syncs[a.syncType] = a.outcome;
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
    async register(_t: string, _p: string, pin: string) {
      calls.push("register"); registeredPins.push(pin);
      if (cfg.registerFails === "definite") throw new Definite("4xx");
      if (cfg.registerFails === "unknown") throw new Error("timeout");
    },
    async subscribeApp() { steps.push("subscribe"); if (cfg.subscribeFails) throw new Definite("4xx"); },
    ...(over.coex ? {
      coex: {
        async ensureInbox() { steps.push("inbox"); return { chatwootAccountId: "2", inboxId: 77, forwardUrl: "https://cw.test/webhooks/whatsapp/%2B15550100" }; },
        async setOverride() { steps.push("override"); if (cfg.overrideFails) throw new Error("timeout"); },
        async requestSync(_t: string, _p: string, t: string) {
          steps.push(`sync:${t}`);
          if (cfg.syncFails === "definite") throw new Definite("4xx");
          if (cfg.syncFails === "unknown") throw new Error("timeout");
          return `req-${t}`;
        },
      },
    } : {}),
    isDefiniteFailure: (e) => e instanceof Definite,
    encrypt: (v) => `enc(${Buffer.from(v).toString("base64")})`,
    ourAppId: "APP1",
    epicWabaIds: new Set(["900000000000777"]),
    protectedPhoneIds: new Set(["900000000000888"]),
    now: () => clock,
  };
  const registers = () => calls.filter((c) => c === "register").length;
  return { deps, lines, conns, calls, steps, attempts, cfg, registers, registeredPins, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
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

  test("coexistence number is refused when this deployment has no coexistence path configured: nothing bound, nothing registered", async () => {
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

test("two concurrent attempts for the same number (two tabs): exactly ONE registration, and the PIN Meta received is the stored PIN (Codex review)", async () => {
  const h = harness();
  const [n1, n2] = [await begin(h), await begin(h)];
  const rs = await Promise.all([finalizeConnect(claim(n1), h.deps), finalizeConnect(claim(n2), h.deps)]);
  const codes = rs.map(code).sort();
  assert.equal(h.registers(), 1, `registers=${h.registers()} codes=${codes}`);
  assert.deepEqual(codes, ["attempt_superseded", "ok"]);
  const c = [...h.conns.values()][0];
  assert.equal(c.pinEnc, h.deps.encrypt(h.registeredPins[0]));
  assert.equal(c.status, "active");
});

test("twin: one attempt alone still registers once and connects", async () => {
  const h = harness();
  assert.equal(code(await finalizeConnect(claim(await begin(h)), h.deps)), "ok");
  assert.equal(h.registers(), 1);
});


describe("subscribe step (standard path)", () => {
  test("the app is subscribed to the customer's WABA after registration and before the binding (twin: positive journey above)", async () => {
    const h = harness();
    assert.equal((await finalizeConnect(claim(await begin(h)), h.deps)).ok, true);
    assert.deepEqual(h.steps, ["subscribe"]);
    assert.equal(h.registers(), 1);
  });
  test("subscribe refused: not connected, stays 'registered'; the retry subscribes and binds WITHOUT registering again", async () => {
    const h = harness({ subscribeFails: true });
    assert.equal(code(await finalizeConnect(claim(await begin(h)), h.deps)), "subscribe_failed");
    assert.deepEqual([h.lines.length, h.registers(), h.conns.get(`${A}/${PHONE}`)?.status], [0, 1, "registered"]);
    h.cfg.subscribeFails = false;
    const r = await finalizeConnect(claim(await begin(h)), h.deps);
    assert.equal(r.ok, true);
    assert.deepEqual([h.lines.length, h.registers(), h.steps.filter((x) => x === "subscribe").length], [1, 1, 2]);
  });
});

describe("coexistence (WhatsApp Business app kept)", () => {
  const BIZ: WabaPhone = { id: PHONE, displayNumber: "+1 555 0100", verifiedName: "Test Co", platformType: "CLOUD_API", isOnBizApp: true };
  const coexClaim = (n: string, o: Record<string, unknown> = {}) => claim(n, { flow: "coexistence", ...o });

  test("positive: Meta reports the Business app -> no registration, no PIN; subscribe, inbox, override, then the two one-time syncs in order", async () => {
    const h = harness({ coex: true, phones: [BIZ] });
    const r = await finalizeConnect(coexClaim(await begin(h)), h.deps);
    assert.deepEqual(r, { ok: true, displayNumber: "+1 555 0100", phoneNumberId: PHONE, mode: "coexistence", resumed: false });
    assert.deepEqual(h.calls, ["exchange", "debug", "list"]); // no "register"
    assert.deepEqual(h.steps, ["subscribe", "inbox", "override", "sync:smb_app_state_sync", "sync:history"]);
    const c = h.conns.get(`${A}/${PHONE}`)!;
    assert.deepEqual([c.status, c.pinEnc, h.lines.length], ["connected_coexistence", undefined, 1]);
    assert.deepEqual(Object.keys(c.syncs ?? {}), ["smb_app_state_sync", "history"]);
    assert.equal(c.syncs!.history!.status, "requested");
  });

  test("twin: the SAME harness with a Cloud API number registers it (the harness can register, so 'no register' above is real)", async () => {
    const h = harness({ coex: true });
    assert.equal((await finalizeConnect(claim(await begin(h)), h.deps)).ok, true);
    assert.equal(h.registers(), 1);
    assert.equal(h.steps.includes("inbox"), false);
  });

  test("negative twin: the browser claims the Business-app flow but Meta says the number is NOT on the app -> refused, nothing done", async () => {
    const h = harness({ coex: true });
    const r = await finalizeConnect(coexClaim(await begin(h)), h.deps);
    assert.equal(code(r), "coexistence_not_confirmed");
    assert.deepEqual([h.lines.length, h.registers(), h.steps.length, h.conns.size], [0, 0, 0, 0]);
  });

  test("the Business-app completion without a phone id: resolved from Meta when exactly one app number exists (twin: two -> refused)", async () => {
    const h = harness({ coex: true, phones: [BIZ, { ...goodPhoneOf("900000000000003"), isOnBizApp: false }] });
    assert.equal((await finalizeConnect(coexClaim(await begin(h), { phoneNumberId: "" }), h.deps)).ok, true);
    assert.equal(h.lines[0].phoneNumberId, PHONE);
    const h2 = harness({ coex: true, phones: [BIZ, { ...BIZ, id: "900000000000004" }] });
    assert.equal(code(await finalizeConnect(coexClaim(await begin(h2), { phoneNumberId: "" }), h2.deps)), "phone_not_on_waba");
    assert.equal(h2.lines.length, 0);
    const h3 = harness({ coex: true });
    assert.equal(code(await finalizeConnect(claim(await begin(h3), { phoneNumberId: "" }), h3.deps)), "bad_input"); // standard flow never resolves
  });

  test("a protected EPIC line found only by resolution is still refused", async () => {
    const h = harness({ coex: true, phones: [{ ...BIZ, id: "900000000000888" }] });
    assert.equal(code(await finalizeConnect(coexClaim(await begin(h), { phoneNumberId: "" }), h.deps)), "protected_asset");
    assert.equal(h.steps.length, 0);
  });

  test("setup step fails (override timeout): 'failed', nothing bound, no sync requested; a fresh attempt completes and requests each sync once", async () => {
    const h = harness({ coex: true, phones: [BIZ], overrideFails: true });
    assert.equal(code(await finalizeConnect(coexClaim(await begin(h)), h.deps)), "coexistence_setup_failed");
    assert.deepEqual([h.conns.get(`${A}/${PHONE}`)?.status, h.lines.length, h.steps.filter((x) => x.startsWith("sync")).length], ["failed", 0, 0]);
    h.cfg.overrideFails = false;
    assert.equal((await finalizeConnect(coexClaim(await begin(h)), h.deps)).ok, true);
    assert.equal(h.steps.filter((x) => x.startsWith("sync")).length, 2);
    assert.equal(h.registers(), 0);
  });

  test("one-time syncs are never repeated: a resumed connect requests nothing new (twin: the first connect requested both)", async () => {
    const h = harness({ coex: true, phones: [BIZ] });
    await finalizeConnect(coexClaim(await begin(h)), h.deps);
    assert.equal(h.steps.filter((x) => x.startsWith("sync")).length, 2);
    const r = await finalizeConnect(coexClaim(await begin(h)), h.deps);
    assert.deepEqual([r.ok, (r as { resumed?: boolean }).resumed], [true, true]);
    assert.equal(h.steps.filter((x) => x.startsWith("sync")).length, 2);
  });

  test("an unknown sync outcome (timeout) is recorded and NOT retried on resume; a definite refusal is recorded as rejected", async () => {
    const h = harness({ coex: true, phones: [BIZ], syncFails: "unknown" });
    assert.equal((await finalizeConnect(coexClaim(await begin(h)), h.deps)).ok, true); // the number IS connected
    assert.deepEqual(Object.values(h.conns.get(`${A}/${PHONE}`)!.syncs!).map((x) => x!.status), ["unknown", "unknown"]);
    h.cfg.syncFails = "none";
    await finalizeConnect(coexClaim(await begin(h)), h.deps);
    assert.equal(h.steps.filter((x) => x.startsWith("sync")).length, 2, "not re-sent");
    const g = harness({ coex: true, phones: [BIZ], syncFails: "definite" });
    await finalizeConnect(coexClaim(await begin(g)), g.deps);
    assert.equal(g.conns.get(`${A}/${PHONE}`)!.syncs!.history!.status, "rejected");
  });

  test("a number already on the standard path is never switched to coexistence (needs_review, nothing done)", async () => {
    const h = harness({ coex: true, failActivate: true });
    await finalizeConnect(claim(await begin(h)), h.deps); // standard: registered, not bound
    h.cfg.failActivate = false;
    const before = h.steps.length;
    const h2deps = { ...h.deps, graph: { ...h.deps.graph, async listWabaPhones() { return [BIZ]; } } };
    assert.equal(code(await finalizeConnect(coexClaim(await begin(h)), h2deps)), "needs_review");
    assert.equal(h.steps.length, before);
  });

  test("audit: every coexistence transition is recorded, with no token in it", async () => {
    const h = harness({ coex: true, phones: [BIZ] });
    const events: Array<[string, Record<string, unknown>]> = [];
    h.deps.audit = (_o, step, props) => { events.push([step, props]); };
    await finalizeConnect(coexClaim(await begin(h)), h.deps);
    assert.deepEqual(events.map((e) => e[0]), ["coex_linking", "connected_coexistence", "sync", "sync"]);
    assert.equal(JSON.stringify(events).includes(TOKEN), false);
    const g = harness({ coex: true });
    const ev2: string[] = []; g.deps.audit = (_o, step) => { ev2.push(step); };
    await finalizeConnect(coexClaim(await begin(g)), g.deps);
    assert.deepEqual(ev2, ["refused"]);
  });
});

function goodPhoneOf(id: string): WabaPhone {
  return { id, displayNumber: "+1 555 0199", verifiedName: "Other", platformType: "CLOUD_API", isOnBizApp: false };
}
