import assert from "node:assert/strict";
import test from "node:test";

import { EnvLinkStore, OrgSettingsLinkStore, parseLinks } from "../../../src/lib/phone-whatsapp/link-store";
import { loadPhoneWhatsappView } from "../../../src/lib/phone-whatsapp/service";
import type { EvidenceResult, LineLink } from "../../../src/lib/phone-whatsapp/types";
import { NOW, ORG_A, ORG_B, WABA, evidence } from "./fixtures";

const PN_A = "111222333444555"; // belongs to workspace A
const PN_B = "555444333222111"; // belongs to workspace B
const WABA_B = "100000000000009";

// Workspace A's evidence is recognisable (its number, its destination); B's is different.
const evFor = (l: LineLink): EvidenceResult => {
  const isA = l.phoneNumberId === PN_A;
  const e = evidence({ wabaId: l.wabaId, phoneNumberId: l.phoneNumberId });
  if (e.meta.ok) e.meta = { ...e.meta, displayNumber: isA ? "+1 555-010-0001" : "+1 555-000-0002", verifiedName: isA ? "Workspace A Co" : "Workspace B Co" };
  if (e.magnus.ok && e.magnus.destination) e.magnus = { ...e.magnus, destination: { ...e.magnus.destination, value: isA ? "PJSIP/A-ROUTE@a-trunk" : "PJSIP/b-route@b-trunk" } };
  return { kind: "evidence", evidence: e };
};

function deps(map: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    d: {
      store: new EnvLinkStore(JSON.stringify(map)),
      provider: async (l: LineLink) => { asked.push(l.phoneNumberId); return evFor(l); },
      now: () => NOW,
      expectedSipHost: "voice.example.test",
    },
  };
}

const TWO = { [ORG_A]: [{ wabaId: WABA, phoneNumberId: PN_A }], [ORG_B]: [{ wabaId: WABA_B, phoneNumberId: PN_B }] };

test("POSITIVE CONTROL: workspace A reads A's own line (its number and route) and only A's ids reach the evidence service", async () => {
  const { d, asked } = deps(TWO);
  const v = await loadPhoneWhatsappView(ORG_A, d);
  assert.equal(v.kind, "lines");
  const s = JSON.stringify(v);
  assert.match(s, /\+1 555-010-0001/);
  assert.match(s, /A-ROUTE/);
  assert.deepEqual(asked, [PN_A]);
});

test("NEGATIVE: workspace B cannot read A's data: B sees only B's line, A's number/route/ids appear nowhere, A's id is never requested", async () => {
  const { d, asked } = deps(TWO);
  const v = await loadPhoneWhatsappView(ORG_B, d);
  const s = JSON.stringify(v);
  assert.equal(v.kind, "lines"); // positive twin: B does get B's own data
  assert.match(s, /Workspace B Co/);
  assert.ok(!s.includes("A-ROUTE"));
  assert.ok(!s.includes("+1 555-010-0001"));
  assert.ok(!s.includes("Workspace A Co"));
  assert.ok(!s.includes(PN_A));
  assert.deepEqual(asked, [PN_B]);
});

test("NEGATIVE: a workspace with no link sees no_link and the evidence service is never called (nothing to read, nothing leaked)", async () => {
  const { d, asked } = deps(TWO);
  const v = await loadPhoneWhatsappView("cccccccc-0000-4000-8000-00000000000c", d);
  assert.deepEqual(v, { kind: "no_link" });
  assert.deepEqual(asked, []);
});

test("NEGATIVE: if B also claims A's number, BOTH workspaces are refused (link_conflict) and nothing is read for either", async () => {
  const { d, asked } = deps({ [ORG_A]: [{ wabaId: WABA, phoneNumberId: PN_A }], [ORG_B]: [{ wabaId: WABA_B, phoneNumberId: PN_B }, { wabaId: WABA, phoneNumberId: PN_A }] });
  assert.deepEqual(await loadPhoneWhatsappView(ORG_A, d), { kind: "link_conflict" });
  assert.deepEqual(await loadPhoneWhatsappView(ORG_B, d), { kind: "link_conflict" });
  assert.deepEqual(asked, []);
});

test("the same ownership rules hold on the database-backed store (settings JSON), including the double-claim refusal", async () => {
  const settings: Record<string, Record<string, unknown>> = {
    [ORG_A]: { phoneWhatsapp: { lines: [{ wabaId: WABA, phoneNumberId: PN_A }] } },
    [ORG_B]: { phoneWhatsapp: { lines: [{ wabaId: WABA_B, phoneNumberId: PN_B }] } },
  };
  const store = (s: typeof settings) => new OrgSettingsLinkStore({
    readSettings: async (id) => s[id] ?? null,
    findOrgsClaiming: async (pn) => Object.entries(s).filter(([, v]) => JSON.stringify(v).includes(`"phoneNumberId":"${pn}"`)).map(([id]) => id),
  });
  const asked: string[] = [];
  const base = { provider: async (l: LineLink) => { asked.push(l.phoneNumberId); return evFor(l); }, now: () => NOW };
  const vB = await loadPhoneWhatsappView(ORG_B, { ...base, store: store(settings) });
  assert.ok(!JSON.stringify(vB).includes("A-ROUTE"));
  assert.deepEqual(asked, [PN_B]);
  const dup = { ...settings, [ORG_B]: { phoneWhatsapp: { lines: [{ wabaId: WABA, phoneNumberId: PN_A }] } } };
  asked.length = 0;
  assert.deepEqual(await loadPhoneWhatsappView(ORG_A, { ...base, store: store(dup) }), { kind: "link_conflict" });
  assert.deepEqual(await loadPhoneWhatsappView(ORG_B, { ...base, store: store(dup) }), { kind: "link_conflict" });
  assert.deepEqual(asked, []);
});

test("an inconsistent store (no claimant, or only someone else) is refused rather than trusted", async () => {
  const mk = (claim: string[]) => ({
    store: { getLinks: async () => [{ wabaId: WABA, phoneNumberId: PN_A }], claimants: async () => claim },
    provider: async (l: LineLink) => evFor(l),
    now: () => NOW,
  });
  assert.deepEqual(await loadPhoneWhatsappView(ORG_A, mk([])), { kind: "link_conflict" });
  assert.deepEqual(await loadPhoneWhatsappView(ORG_A, mk([ORG_B])), { kind: "link_conflict" });
  assert.equal((await loadPhoneWhatsappView(ORG_A, mk([ORG_A]))).kind, "lines"); // positive twin
});

test("only a real session workspace id is accepted: empty or short ids throw (no anonymous or caller-supplied identity)", async () => {
  const { d } = deps(TWO);
  await assert.rejects(loadPhoneWhatsappView("", d));
  await assert.rejects(loadPhoneWhatsappView("A", d));
  await assert.rejects(loadPhoneWhatsappView(undefined as unknown as string, d));
});

test("malformed or hostile link entries are dropped, never repaired (ids must be digits)", () => {
  const out = parseLinks([
    { wabaId: WABA, phoneNumberId: PN_A, label: "  Front desk  " },
    { wabaId: WABA, phoneNumberId: PN_A }, // duplicate
    { wabaId: "100000000000001; rm -rf /", phoneNumberId: PN_A },
    { wabaId: WABA, phoneNumberId: "../../etc" },
    { wabaId: WABA },
    "not an object",
    null,
  ]);
  assert.deepEqual(out, [{ wabaId: WABA, phoneNumberId: PN_A, label: "Front desk" }]);
  assert.deepEqual(parseLinks("nope"), []);
});

test("unparseable env link config means NO links (fail closed), not 'all workspaces'", async () => {
  const s = new EnvLinkStore("{not json");
  assert.deepEqual(await s.getLinks(ORG_A), []);
  assert.deepEqual(await s.claimants(PN_A), []);
});

test("an evidence provider that throws becomes an unknown line, not a crashed page", async () => {
  const d = { store: new EnvLinkStore(JSON.stringify(TWO)), provider: async () => { throw new Error("boom"); }, now: () => NOW };
  const v = await loadPhoneWhatsappView(ORG_A, d);
  assert.equal(v.kind, "lines");
  if (v.kind === "lines") {
    assert.equal(v.lines[0].connection.tone, "unknown");
    assert.match(v.lines[0].connection.detail, /boom/);
  }
});
