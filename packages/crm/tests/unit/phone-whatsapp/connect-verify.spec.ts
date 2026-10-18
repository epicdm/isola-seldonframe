// Every refusal in verifyClaimedAssets is paired with the positive control in the same harness: the SAME fixture, one field changed,
// is accepted. Without the twin, a broken fixture would make every refusal pass vacuously.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  verifyClaimedAssets,
  type DebugToken,
  type GraphClient,
  type VerifyDeps,
  type WabaPhone,
} from "../../../src/lib/phone-whatsapp/connect/verify-assets";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const WABA = "900000000000001";
const PHONE = "900000000000002";

const goodToken: DebugToken = {
  isValid: true,
  appId: "APP1",
  scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
  wabaTargets: [WABA],
};
const goodPhone: WabaPhone = { id: PHONE, displayNumber: "+1 555 0100", verifiedName: "Test Co", platformType: "CLOUD_API", isOnBizApp: false };

function deps(over: { token?: Partial<DebugToken>; phones?: WabaPhone[]; owners?: string[]; throwDebug?: boolean; throwList?: boolean; epic?: string[]; prot?: string[] } = {}): VerifyDeps {
  const graph: GraphClient = {
    async debugToken() {
      if (over.throwDebug) throw new Error("down");
      return { ...goodToken, ...over.token };
    },
    async listWabaPhones() {
      if (over.throwList) throw new Error("down");
      return over.phones ?? [goodPhone];
    },
  };
  return {
    graph,
    ourAppId: "APP1",
    epicWabaIds: new Set(over.epic ?? ["900000000000777"]),
    protectedPhoneIds: new Set(over.prot ?? ["900000000000888"]),
    claimants: async () => over.owners ?? [],
  };
}
const input = (o: Partial<{ token: string; wabaId: unknown; phoneNumberId: unknown; orgId: string }> = {}) => ({
  token: "tok", wabaId: WABA, phoneNumberId: PHONE, orgId: ORG, ...o,
});

describe("verifyClaimedAssets", () => {
  test("positive control: a correct claim is verified, with Meta's facts (not the browser's)", async () => {
    const r = await verifyClaimedAssets(input(), deps());
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.wabaId, r.phoneNumberId, r.displayNumber], [WABA, PHONE, "+1 555 0100"]);
  });

  const cases: Array<[string, Parameters<typeof deps>[0], Parameters<typeof input>[0], string]> = [
    ["bad_input: empty token", {}, { token: "" }, "bad_input"],
    ["bad_input: non-digit waba", {}, { wabaId: "12ab" }, "bad_input"],
    ["bad_input: non-string phone", {}, { phoneNumberId: { $ne: 1 } }, "bad_input"],
    ["epic_owned_waba", {}, { wabaId: "900000000000777" }, "epic_owned_waba"],
    ["protected_asset", {}, { phoneNumberId: "900000000000888" }, "protected_asset"],
    ["token_invalid", { token: { isValid: false } }, {}, "token_invalid"],
    ["wrong_app", { token: { appId: "OTHER_APP" } }, {}, "wrong_app"],
    ["missing_scope (messaging)", { token: { scopes: ["whatsapp_business_management"] } }, {}, "missing_scope"],
    ["missing_scope (management)", { token: { scopes: ["whatsapp_business_messaging"] } }, {}, "missing_scope"],
    ["waba_not_authorised", { token: { wabaTargets: ["900000000000099"] } }, {}, "waba_not_authorised"],
    ["phone_not_on_waba", { phones: [{ ...goodPhone, id: "900000000000077" }] }, {}, "phone_not_on_waba"],
    ["coexistence via is_on_biz_app", { phones: [{ ...goodPhone, isOnBizApp: true }] }, {}, "coexistence_not_supported_here"],
    ["coexistence via platform_type", { phones: [{ ...goodPhone, platformType: "NOT_APPLICABLE_BUSINESS_APP", isOnBizApp: null }] }, {}, "coexistence_not_supported_here"],
    ["not_cloud_api", { phones: [{ ...goodPhone, platformType: "ON_PREMISE" }] }, {}, "not_cloud_api"],
    ["platform missing (Codex review: fail closed)", { phones: [{ ...goodPhone, platformType: null }] }, {}, "platform_unverified"],
    ["platform unrecognised", { phones: [{ ...goodPhone, platformType: "SOMETHING_NEW" }] }, {}, "not_cloud_api"],
    ["already_bound to another workspace", { owners: [OTHER] }, {}, "already_bound"],
    ["already_bound: two claimants even if one is us", { owners: [ORG, OTHER] }, {}, "already_bound"],
    ["meta_unavailable on debug_token", { throwDebug: true }, {}, "meta_unavailable"],
    ["meta_unavailable on phone list", { throwList: true }, {}, "meta_unavailable"],
  ];
  for (const [name, d, i, code] of cases) {
    test(`refuses: ${name}`, async () => {
      const r = await verifyClaimedAssets(input(i), deps(d));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, code);
    });
  }

  test("re-connecting the number this workspace already owns is accepted (idempotent), not 'already bound'", async () => {
    const r = await verifyClaimedAssets(input(), deps({ owners: [ORG] }));
    assert.equal(r.ok, true);
  });

  test("a hostile browser hint cannot widen anything: claimed phone absent from Meta's list is refused even when waba is authorised", async () => {
    const r = await verifyClaimedAssets(input({ phoneNumberId: "900000000000003" }), deps());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "phone_not_on_waba");
  });

  test("Meta is not asked anything for EPIC-owned assets (local refusal before any network call)", async () => {
    let calls = 0;
    const d = deps();
    const orig = d.graph.debugToken.bind(d.graph);
    d.graph.debugToken = async (t) => { calls++; return orig(t); };
    await verifyClaimedAssets(input({ wabaId: "900000000000777" }), d);
    assert.equal(calls, 0);
    await verifyClaimedAssets(input(), d);
    assert.equal(calls, 1); // positive control: the counter does count
  });
});

test("accepts NOT_APPLICABLE (on the WABA, not yet registered: this check runs before registration) when not on the Business app; twin: CLOUD_API", async () => {
  for (const platformType of ["NOT_APPLICABLE", "CLOUD_API"]) {
    const r = await verifyClaimedAssets(input({}), deps({ phones: [{ ...goodPhone, platformType, isOnBizApp: false }] }));
    assert.equal(r.ok, true, platformType);
  }
});
