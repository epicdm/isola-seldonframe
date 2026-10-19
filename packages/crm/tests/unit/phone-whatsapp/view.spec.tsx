// Renders the real component for every state the customer can see. Positive and negative expectations sit side by side.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import PhoneWhatsappLoading from "../../../src/app/(dashboard)/phone-whatsapp/loading";
import { PhoneWhatsappView } from "../../../src/app/(dashboard)/phone-whatsapp/view";
import { buildLineView } from "../../../src/lib/phone-whatsapp/view-model";
import type { PageView } from "../../../src/lib/phone-whatsapp/types";
import { LINK, NOW, evidence, ok } from "./fixtures";

const opts = { now: NOW, expectedSipHost: "voice.example.test", proofWindowDays: 30 };
const lines = (...v: ReturnType<typeof buildLineView>[]): PageView => ({ kind: "lines", lines: v });
const render = (view: PageView, wa: string | null = "15550100099") => renderToString(<PhoneWhatsappView view={view} waNumber={wa} />);

describe("<PhoneWhatsappView>", () => {
  test("healthy line: every row present, OK badges, timestamps with 'As of ... UTC', source named, route shown", () => {
    const html = render(lines(buildLineView(LINK, ok(), opts)));
    for (const row of ["WhatsApp connection", "Calling eligibility", "Call destination", "Routing readiness", "Last call"]) assert.match(html, new RegExp(row));
    assert.match(html, /Eligible: all 6 checks pass/);
    assert.match(html, /Configured; a recent call was answered/);
    assert.match(html, /As of 2026-10-17 18:59:50 UTC/);
    assert.match(html, /2026-10-17 12:57:27 UTC/);
    assert.match(html, /PJSIP\/15550100001@pbx-trunk/);
    assert.match(html, /Meta WhatsApp Business API/);
    assert.match(html, /EPIC voice platform/);
  });

  test("a line whose evidence is partly missing shows Unknown with the actual reason, never a green claim", () => {
    const e = evidence({ calling: { ok: false, error: "Meta HTTP 400: no settings" } });
    const html = render(lines(buildLineView(LINK, ok(e), opts)));
    assert.match(html, /Cannot confirm eligibility/);
    assert.match(html, /Meta HTTP 400: no settings/);
    assert.match(html, /Cannot assess routing/);
    assert.doesNotMatch(html, /Eligible: all/);
    assert.doesNotMatch(html, /Proven by/);
  });

  test("a mislinked or unreadable number: Meta's real failure text is shown and nothing is called OK for it", () => {
    const e = evidence({ meta: { ok: false, error: "Meta HTTP 400: Unsupported get request" }, calling: { ok: false, error: "not read: the number could not be confirmed at Meta" }, magnus: { ok: false, error: "no display number to look up (Meta read failed)" } });
    const html = render(lines(buildLineView(LINK, ok(e), opts)));
    assert.match(html, /Could not read this number from Meta/);
    assert.match(html, /Unsupported get request/);
    assert.match(html, /Number not confirmed/);
    assert.doesNotMatch(html, />OK</);
  });

  test("evidence service down or not configured: every row Unknown with the reason", () => {
    for (const [r, re] of [[{ kind: "failed" as const, error: "the evidence service did not answer in time" }, /did not answer in time/], [{ kind: "not_configured" as const }, /not configured on this server/]] as const) {
      const html = render(lines(buildLineView(LINK, r, opts)));
      assert.match(html, re);
      assert.doesNotMatch(html, />OK</);
      assert.match(html, /No evidence time/);
    }
  });

  test("calling configured but no answered call: 'Configured; no answered call on record' and the no-record last-call text", () => {
    const e = evidence();
    if (!e.magnus.ok) throw new Error("fixture");
    const html = render(lines(buildLineView(LINK, ok({ ...e, magnus: { ...e.magnus, lastCalls: [] } }), opts)));
    assert.match(html, /Configured; no answered call on record/);
    assert.match(html, /No call record found for this number/);
  });

  test("eligibility passing is never presented as an acceptance call: separate row, always Unknown, with an explicit caveat", () => {
    const html = render(lines(buildLineView(LINK, ok(), opts)));
    assert.match(html, /Eligible: all 6 checks pass/); // positive control: the all-green state is on screen
    assert.match(html, /data-testid="row-Acceptance call"/);
    const row = html.slice(html.indexOf('data-testid="row-Acceptance call"'));
    assert.match(row.slice(0, 900), /Unknown/);
    assert.match(row, /No customer acceptance call is recorded/);
    assert.match(html, /does not mean a customer acceptance call has passed/);
    assert.doesNotMatch(row.slice(0, 900), />OK</); // the acceptance row can never be green in this version
  });

  test("loading state: static status message, no data, no inputs, names what it is waiting for", () => {
    const html = renderToString(<PhoneWhatsappLoading />);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /Reading live status from Meta/);
    for (const tag of [/<form/i, /<input/i, /<button/i, /<a/i]) assert.doesNotMatch(html, tag);
    assert.doesNotMatch(html, /wa\.me|Eligible|OK</);
  });

  test("no linked number: honest empty state with the staff-assisted action, no line cards", () => {
    const html = render({ kind: "no_link" });
    assert.match(html, /No WhatsApp business number is linked to this workspace/);
    assert.match(html, /data-testid="staff-action"/);
    assert.doesNotMatch(html, /data-testid="line-card"/);
  });

  test("ownership conflict: nothing about the number is shown", () => {
    const html = render({ kind: "link_conflict" });
    assert.match(html, /This number cannot be shown/);
    assert.doesNotMatch(html, /data-testid="line-card"/);
    assert.match(html, /data-testid="staff-action"/);
  });

  test("staff action is a wa.me link to the configured contact; when unconfigured it says so instead of a dead button", () => {
    const withWa = render({ kind: "no_link" }, "15550100099");
    assert.match(withWa, /href="https:\/\/wa\.me\/15550100099\?text=/);
    assert.match(withWa, /rel="noopener noreferrer"/);
    const without = render({ kind: "no_link" }, null);
    assert.match(without, /data-testid="staff-action-missing"/);
    assert.doesNotMatch(without, /wa\.me/);
  });

  test("NO write surface in any rendered state: no form, input, select, textarea; the change-destination control is a disabled button", () => {
    for (const v of [lines(buildLineView(LINK, ok(), opts)), { kind: "no_link" } as PageView, { kind: "link_conflict" } as PageView]) {
      const html = render(v);
      for (const tag of [/<form\b/i, /<input\b/i, /<select\b/i, /<textarea\b/i]) assert.doesNotMatch(html, tag);
    }
    const html = render(lines(buildLineView(LINK, ok(), opts)));
    assert.match(html, /<button[^>]*disabled[^>]*data-testid="change-destination-disabled"|<button[^>]*data-testid="change-destination-disabled"[^>]*disabled/);
    assert.match(html, /Change call destination \(staff only\)/);
  });

  test("the journey strip names all five steps; connecting is self-service, call setup and acceptance are staff-assisted", () => {
    const html = render({ kind: "no_link" });
    for (const t of ["Connect WhatsApp number", "Select number", "Configure destination", "Verify routing", "Acceptance call"]) assert.match(html, new RegExp(t));
    assert.match(html, /Self-service for a workspace owner or admin/);
    assert.match(html, /Staff-assisted today/); // configure destination + acceptance stay staff-assisted
    assert.doesNotMatch(html, /Meta sign-in happens with EPIC staff/);
  });

  test("no linked number, connecting available: points at the Connect panel and no longer says linking is staff-only", () => {
    const html = renderToString(<PhoneWhatsappView view={{ kind: "no_link" }} waNumber={null} canConnect />);
    assert.match(html, /Connect your WhatsApp number/);
    assert.doesNotMatch(html, /Linking a number is a staff-assisted step/);
    const without = renderToString(<PhoneWhatsappView view={{ kind: "no_link" }} waNumber={null} canConnect={false} />);
    assert.match(without, /owner or admin can connect a number/); // control: the non-admin text differs
    assert.doesNotMatch(without, /Use .Connect your WhatsApp number. above/);
  });
});
