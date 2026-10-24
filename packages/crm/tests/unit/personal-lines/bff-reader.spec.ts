import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPersonalLineBffReader } from "../../../src/lib/personal-lines/bff-reader";

const accountId = "trusted-account-123";
const detail = {
  account: { odooPartnerId: 42, intendedDid: "+1 767 555 0123", liteAccountId: "must-not-leak" },
  registration: { status: "ok", peerStatus: "registered", registeredAt: "2026-10-24T10:00:00.000Z" },
  wallet: {
    status: "active", balanceEc: 10, currency: "EC$",
    recentCredits: [{ kind: "credit", state: "credited", at: "2026-10-24T10:00:00.000Z", amountEc: 10, paymentCurrency: "USD", minutes: 60, referenceKind: "payment" }],
    planAllowance: { planName: "Day Pass", expiresAt: "2026-10-25T10:00:00.000Z" },
  },
  plan: { status: "active", state: "active", planName: "Day Pass", expiresAt: "2026-10-25T10:00:00.000Z" },
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function readerWith(fetchImpl: typeof fetch, options: { baseUrl?: string; readTokenFile?: string } = {}) {
  return createPersonalLineBffReader({
    baseUrl: options.baseUrl ?? "https://bff.example",
    readTokenFile: options.readTokenFile ?? "token-file",
    readFile: () => "x".repeat(40),
    fetchImpl,
  });
}

describe("tenant Personal Line BFF evidence reader", () => {
  test("does not call upstream when the established credential configuration is absent", async () => {
    let called = false;
    const reader = createPersonalLineBffReader({ baseUrl: "https://bff.example", readFile: () => "x".repeat(40), fetchImpl: async () => { called = true; return response({}); } });
    assert.deepEqual(await reader(accountId), { status: "unavailable" });
    assert.equal(called, false);
  });

  test("returns sanitized detail only when customer services bind the intended DID exactly once", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return calls.length === 1
        ? response(detail)
        : response({ services: [{ did: "+17675550123", sipRegistered: true, magnusUserAssigned: true, createdAt: "2026-10-01T00:00:00.000Z", liteAccountId: "must-not-leak" }] });
    };
    const evidence = await readerWith(fetchImpl)(accountId);
    assert.equal(evidence.status, "verified");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `https://bff.example/api/internal/personal-line/${accountId}/service-detail`);
    assert.deepEqual(JSON.parse(await calls[1].text()), { odooPartnerId: 42 });
    assert.equal(JSON.stringify(evidence).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(evidence).includes("trusted-account-123"), false);
    assert.equal(JSON.stringify(evidence).includes("42"), false);
    assert.deepEqual(evidence.status === "verified" ? evidence.wallet.credits.length : -1, 1);
  });

  test("fails closed when the DID is absent or duplicated in the shared association", async () => {
    for (const services of [[], [{ did: "+17675550123" }, { did: "+1 767 555 0123" }]]) {
      let call = 0;
      const result = await readerWith(async () => ++call === 1 ? response(detail) : response({ services }))(accountId);
      assert.deepEqual(result, { status: "association_mismatch" });
    }
  });
});
