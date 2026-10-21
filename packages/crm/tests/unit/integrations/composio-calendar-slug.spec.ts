// Google Calendar event reading (owner-reported 2026-10-21): Uplink advertised
// GOOGLECALENDAR_LIST_EVENTS, which Composio renamed to GOOGLECALENDAR_EVENTS_LIST
// (the old slug fails "Unable to retrieve tool with slug ..."). And a custom
// agent script replaced the only prompt section carrying today's date, so
// "next 7 days" resolved to an arbitrary past window.
// Path tests: saved binding -> runtime tool list -> executor slug; catalog
// defaults; replay effect; system prompt date grounding.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveComposioBinding,
  type ComposioBinding,
} from "../../../src/lib/integrations/composio/connector";
import { defaultToolsForToolkits } from "../../../src/lib/integrations/composio/catalog";
import { effectForTool } from "../../../src/lib/deployments/replay/tool-effects";
import { composeSystemPrompt } from "../../../src/lib/agents/prompt";
import type { AgentBlueprint } from "../../../src/db/schema/agents";

function savedBinding(enabledTools: string[]): ComposioBinding {
  return {
    id: "composio",
    kind: "composio",
    enabledToolkits: ["gmail", "googlecalendar"],
    enabledTools,
    tools: [],
    discoveredAt: "2026-10-21T00:00:00.000Z",
  };
}

function run(enabledTools: string[]) {
  const calls: string[] = [];
  const tools = resolveComposioBinding(savedBinding(enabledTools), {
    executeTool: async (_org: string, tool: string) => {
      calls.push(tool);
      return { items: [] };
    },
  });
  return { calls, names: tools.map((t) => t.name), tools };
}

const ctx = { orgId: "org-1", agentId: "a", conversationId: "c", testMode: true } as never;

describe("Calendar list-events slug", () => {
  test("a SAVED binding with the old slug exposes and executes the current EVENTS_LIST slug", async () => {
    const r = run(["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_LIST_EVENTS", "GOOGLECALENDAR_FIND_EVENT"]);
    assert.deepEqual(r.names, [
      "composio__GMAIL_FETCH_EMAILS",
      "composio__GOOGLECALENDAR_EVENTS_LIST",
      "composio__GOOGLECALENDAR_FIND_EVENT",
    ]);
    await r.tools[1].execute({ time_min: "2026-10-21T00:00:00Z" }, ctx);
    assert.deepEqual(r.calls, ["GOOGLECALENDAR_EVENTS_LIST"]);
  });

  test("old + new slug both saved -> exposed once (no duplicate tool)", () => {
    const r = run(["GOOGLECALENDAR_LIST_EVENTS", "GOOGLECALENDAR_EVENTS_LIST"]);
    assert.deepEqual(r.names, ["composio__GOOGLECALENDAR_EVENTS_LIST"]);
  });

  test("control: unrenamed slugs are untouched (and nothing is added)", async () => {
    const r = run(["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_CREATE_EVENT"]);
    assert.deepEqual(r.names, ["composio__GMAIL_FETCH_EMAILS", "composio__GOOGLECALENDAR_CREATE_EVENT"]);
    await r.tools[0].execute({}, ctx);
    assert.deepEqual(r.calls, ["GMAIL_FETCH_EMAILS"]);
  });

  test("new chip selections seed the current slug, never the retired one", () => {
    const d = defaultToolsForToolkits(["googlecalendar"]);
    assert.ok(d.includes("GOOGLECALENDAR_EVENTS_LIST"));
    assert.ok(!d.includes("GOOGLECALENDAR_LIST_EVENTS"));
  });

  test("replay classifies the current slug as read (unknown would be destructive)", () => {
    assert.equal(effectForTool("GOOGLECALENDAR_EVENTS_LIST"), "read");
  });
});

describe("custom script gets today's date (temporal grounding)", () => {
  const base = { capabilities: [], pricingFacts: [], faq: [] };
  const now = new Date("2026-10-21T15:00:00Z");

  test("{{currentDate}}/{{timezone}} placeholders in a custom script are rendered", async () => {
    const prompt = await composeSystemPrompt({
      orgName: "Test Co",
      soul: null,
      blueprint: { ...base, customSkillMd: "Today is {{currentDate}} ({{timezone}}). Read only." } as unknown as AgentBlueprint,
      archetype: "website-chatbot",
      now,
      timezone: "America/Dominica",
    });
    assert.match(prompt, /Today is Wednesday, October 21, 2026 \(America\/Dominica\)\. Read only\./);
    assert.doesNotMatch(prompt, /\{\{currentDate\}\}/);
  });

  test("control: unknown placeholders are left untouched; scripts without placeholders unchanged", async () => {
    const prompt = await composeSystemPrompt({
      orgName: "Test Co",
      soul: null,
      blueprint: { ...base, customSkillMd: "Keep {{customerName}} literal. Plain line." } as unknown as AgentBlueprint,
      archetype: "website-chatbot",
      now,
      timezone: "UTC",
    });
    assert.match(prompt, /Keep \{\{customerName\}\} literal\. Plain line\./);
  });
});
