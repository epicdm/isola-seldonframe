import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { ServiceStatesCard } from "../../../src/app/(dashboard)/phone-whatsapp/service-states";
import { deriveServiceStates } from "../../../src/lib/phone-whatsapp/service/states";

const routed = { didActive: true, destinationActive: true, destinationTarget: "t/1" };
const attached = { idempotencyKey: "k", destinationId: "d", steps: {}, status: "attached" as const, leaseUntil: null };

describe("<ServiceStatesCard>", () => {
  test("connected to Meta but not set up: says connected AND not ready, and never says the service is ready", () => {
    const html = renderToString(<ServiceStatesCard states={deriveServiceStates({ connectionStatus: "active", ledger: null, routing: null, expectedTarget: null, acceptance: null })} />);
    assert.match(html, /Connected to Meta/);
    assert.match(html, /Calling service not set up yet/);
    assert.match(html, /Calling service is not ready yet/);
    assert.doesNotMatch(html, /verified ready/);
    assert.doesNotMatch(html, /not monitored continuously/);
    assert.match(html, /Choose where calls are answered/);
  });
  test("all four good: the only state that says ready, and it says ready AS OF the stated time, not continuously (positive control)", () => {
    const html = renderToString(<ServiceStatesCard observedAt="2026-10-18T05:21:00.000Z" states={deriveServiceStates({ connectionStatus: "active", ledger: attached, routing: routed, expectedTarget: "t/1", acceptance: "accepted" })} />);
    assert.match(html, /verified ready as of 2026-10-18 05:21 UTC/);
    assert.match(html, /not monitored continuously/);
    assert.match(html, /worked in both directions/);
  });
  test("four separate labelled rows are always present", () => {
    const html = renderToString(<ServiceStatesCard states={deriveServiceStates({ connectionStatus: null, ledger: null, routing: null, expectedTarget: null, acceptance: null })} />);
    for (const l of ["Connection to Meta:", "Calling service setup:", "Routing:", "Acceptance call:"]) assert.match(html, new RegExp(l.replace(":", "(<!-- -->)?:")));
  });
});
