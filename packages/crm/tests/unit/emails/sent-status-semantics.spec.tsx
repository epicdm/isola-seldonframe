// packages/crm/tests/unit/emails/sent-status-semantics.spec.tsx
//
// Sent screen status semantics (2026-10-21). Renders the real
// <EmailPageContent>, opens the Sent tab the way an operator does, and reads
// the status badge each row shows.
//  - provider "manual": nothing was handed to any transport, yet the row is
//    stored with status "sent". The badge must say it was NOT sent.
//  - provider "smtp2go": a 2xx from SMTP2GO means "accepted for delivery";
//    there is no SMTP2GO delivery webhook in this app, so the badge must not
//    read as delivered/sent - it says "Submitted to SMTP2GO".
//  - Controls: a recorded delivery event still shows as delivered, and Resend
//    rows (which DO get delivery webhooks) are unchanged.
import "../../setup-dom";

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { EmailPageContent } from "../../../src/components/emails/email-page-content";
import { countSentEmails, TRANSPORT_PROVIDER_IDS } from "../../../src/lib/emails/sent-count";

afterEach(() => cleanup());

const noop = async () => {};
const integrations = {
  resend: { connected: false, maskedKey: "", fromEmail: "", fromName: "" },
  twilio: { connected: false, accountSid: "", fromNumber: "", authTokenHint: "" },
  newsletter: {
    kit: { connected: false, maskedKey: "" },
    mailchimp: { connected: false, maskedKey: "" },
    beehiiv: { connected: false, maskedKey: "" },
  },
};

type Row = {
  id: string;
  toEmail: string;
  subject: string;
  status: string;
  provider: string;
  sentAt: string | null;
  providerConfigured?: boolean | null;
};
const row = (id: string, provider: string, status: string): Row => ({
  id,
  toEmail: `${id}@example.test`,
  subject: `subject ${id}`,
  status,
  provider,
  sentAt: "2026-10-21T10:00:00.000Z",
});

function badgesFor(rows: Row[]) {
  const { container } = render(
    <EmailPageContent
      templates={[]}
      sent={rows}
      createTemplateAction={noop}
      emailIntegrations={integrations}
      saveIntegrationAction={noop}
      disconnectIntegrationAction={noop}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Sent \(/ }));
  // Positive control: the Sent list really rendered every row, so an
  // absence assertion below cannot pass on an empty screen.
  for (const r of rows) assert.ok(screen.getByText(r.toEmail), `row ${r.id} not rendered`);
  const badges = Array.from(container.querySelectorAll("span.rounded-full")).map((el) => ({
    text: (el.textContent ?? "").trim(),
    cls: el.className,
  }));
  assert.equal(badges.length, rows.length, "one status badge per row");
  return badges;
}

describe("Sent screen status semantics", () => {
  test("manual row from the send path (providerConfigured=false): not sent, no provider, not green", () => {
    const [b] = badgesFor([{ ...row("m1", "manual", "sent"), providerConfigured: false }]);
    assert.equal(b.text, "Not sent — no email provider configured");
    assert.doesNotMatch(b.cls, /text-positive/);
  });

  test("manual row with no config record (e.g. portal notification): 'Not sent', no config claim", () => {
    const [b] = badgesFor([row("m2", "manual", "queued")]);
    assert.equal(b.text, "Not sent");
    assert.doesNotMatch(b.cls, /text-positive/);
  });

  test("header count: manual rows are not counted as sent (control: real sends are)", () => {
    assert.equal(countSentEmails([row("m3", "manual", "sent"), row("m4", "manual", "queued")]), 0);
    assert.equal(countSentEmails([row("r4", "resend", "sent"), row("s4", "smtp2go", "sent"), row("m5", "manual", "sent")]), 2);
    assert.equal(
      countSentEmails(["failed", "bounced", "complained", "queued"].map((s, i) => row(`x${i}`, "resend", s))),
      0,
      "failed/bounced/complained/queued are not sends",
    );
  });

  test("smtp2go row without a delivery event: 'Submitted to SMTP2GO', not green", () => {
    const [b] = badgesFor([row("s1", "smtp2go", "sent")]);
    assert.equal(b.text, "Submitted to SMTP2GO");
    assert.doesNotMatch(b.cls, /text-positive/);
  });

  test("control: smtp2go row WITH a recorded delivery shows delivered", () => {
    const [b] = badgesFor([row("s2", "smtp2go", "delivered")]);
    assert.equal(b.text, "delivered");
    assert.match(b.cls, /text-positive/);
  });

  test("control: resend rows unchanged (sent / delivered / bounced)", () => {
    const b = badgesFor([row("r1", "resend", "sent"), row("r2", "resend", "delivered"), row("r3", "resend", "bounced")]);
    assert.deepEqual(b.map((x) => x.text), ["sent", "delivered", "bounced"]);
    assert.match(b[0].cls, /text-positive/);
    assert.match(b[2].cls, /text-negative/);
  });

  test("provider with no implementation (sendgrid) renders 'Not sent'", () => {
    const [b] = badgesFor([row("g1", "sendgrid", "sent")]);
    assert.equal(b.text, "Not sent");
    assert.doesNotMatch(b.cls, /text-positive/);
  });

  test("tab label uses the same count as the header (only real sent/delivered)", () => {
    const rows = [
      row("t1", "resend", "sent"),
      row("t2", "smtp2go", "sent"),
      row("t3", "smtp2go", "delivered"),
      row("t4", "manual", "sent"),
      row("t5", "sendgrid", "sent"),
      row("t6", "resend", "bounced"),
      row("t7", "resend", "queued"),
    ];
    render(
      <EmailPageContent
        templates={[]}
        sent={rows}
        createTemplateAction={noop}
        emailIntegrations={integrations}
        saveIntegrationAction={noop}
        disconnectIntegrationAction={noop}
      />,
    );
    assert.equal(countSentEmails(rows), 3);
    assert.ok(screen.getByRole("button", { name: "Sent (3)" }), "tab label must equal the header count");
  });

  test("dates: not-sent rows show '—'; real sends keep their date (control)", () => {
    const rows = [row("d1", "manual", "sent"), row("d2", "sendgrid", "sent"), row("d3", "resend", "sent")];
    const { container } = render(
      <EmailPageContent
        templates={[]}
        sent={rows}
        createTemplateAction={noop}
        emailIntegrations={integrations}
        saveIntegrationAction={noop}
        disconnectIntegrationAction={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Sent \(/ }));
    const dates = Array.from(container.querySelectorAll("p.shrink-0")).map((el) => (el.textContent ?? "").trim());
    assert.equal(dates.length, 3, "one date cell per row");
    assert.equal(dates[0], "—");
    assert.equal(dates[1], "—");
    assert.notEqual(dates[2], "—");
    assert.match(dates[2], /21/);
  });

  test("TRANSPORT_PROVIDER_IDS matches the emailProviders registry", async () => {
    const { emailProviders } = await import("../../../src/lib/emails/providers");
    assert.deepEqual([...TRANSPORT_PROVIDER_IDS].sort(), Object.keys(emailProviders).sort());
  });

  test("control: smtp2go failure still reads as failed", () => {
    const [b] = badgesFor([row("s3", "smtp2go", "failed")]);
    assert.equal(b.text, "failed");
    assert.match(b.cls, /text-negative/);
  });
});
