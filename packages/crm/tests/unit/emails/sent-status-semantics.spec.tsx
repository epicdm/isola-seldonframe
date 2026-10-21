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

type Row = { id: string; toEmail: string; subject: string; status: string; provider: string; sentAt: string | null };
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
  test("manual row: says not sent, never 'sent', not green", () => {
    const [b] = badgesFor([row("m1", "manual", "sent")]);
    assert.equal(b.text, "Not sent — no email provider configured");
    assert.doesNotMatch(b.cls, /text-positive/);
  });

  test("manual row stays 'not sent' whatever status was stored", () => {
    const [b] = badgesFor([row("m2", "manual", "queued")]);
    assert.equal(b.text, "Not sent — no email provider configured");
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

  test("control: smtp2go failure still reads as failed", () => {
    const [b] = badgesFor([row("s3", "smtp2go", "failed")]);
    assert.equal(b.text, "failed");
    assert.match(b.cls, /text-negative/);
  });
});
