// Path test (Law 20): the per-tool result cap through the REAL stateless agent
// loop (the Studio Test page path). A composio binding exposes the Docs read +
// Gmail fetch; the tool outputs are supplied via the existing wrapToolCall seam;
// a fake Anthropic client captures EXACTLY what the model is sent. Only the
// Composio key lookup (DB) is module-mocked.
//
// Needs: node --experimental-test-module-mocks --import tsx --test <this file>

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, describe, mock, test } from "node:test";

import type { AgentBlueprint } from "../../src/db/schema/agents";

const crm = path.resolve(__dirname, "../..");
const DOC = "composio__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT";
const GMAIL = "composio__GMAIL_FETCH_EMAILS";

function docFixture(len: number): string {
  const tail = '\n## FINAL SECTION\nAction: ship it "today".\n';
  let body = "";
  let i = 0;
  while (body.length < len - tail.length) {
    body += `Section ${i}: "Item" line with some text.\n`;
    i += 1;
  }
  return body.slice(0, len - tail.length) + tail;
}

let runStatelessAgentTurn: typeof import("../../src/lib/agents/stateless-turn").runStatelessAgentTurn;

before(async () => {
  mock.module(pathToFileURL(path.join(crm, "src/lib/integrations/composio/keys.ts")).href, {
    namedExports: {
      resolveComposioKey: async () => ({ apiKey: "test-key", source: "byo" }),
      resolveComposioKeyFromInputs: () => ({ apiKey: "test-key", source: "byo" }),
    },
  });
  ({ runStatelessAgentTurn } = await import("../../src/lib/agents/stateless-turn"));
});

type Sent = Array<{ role: string; content: unknown }>;

function scriptedClient() {
  const sent: Sent[] = [];
  const responses = [
    { content: [{ type: "tool_use", id: "t1", name: DOC, input: { document_id: "d1" } }], stop_reason: "tool_use" },
    { content: [{ type: "tool_use", id: "t2", name: GMAIL, input: { max_results: 5 } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  ];
  let i = 0;
  const client = {
    messages: {
      create: async (req: { messages: Sent }) => {
        sent.push(JSON.parse(JSON.stringify(req.messages)));
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return { ...r, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { client: client as never, sent };
}

function toolResultContent(sent: Sent[], id: string): string {
  for (const msgs of sent) {
    for (const m of msgs) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: string }>) {
        if (b.type === "tool_result" && b.tool_use_id === id) return String(b.content);
      }
    }
  }
  throw new Error(`no tool_result for ${id}`);
}

const blueprint: AgentBlueprint = {
  capabilities: [],
  connectors: [
    {
      id: "composio",
      kind: "composio",
      enabledToolkits: ["gmail", "googledocs"],
      enabledTools: ["GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", "GMAIL_FETCH_EMAILS"],
      tools: [],
      discoveredAt: "2026-10-21T00:00:00.000Z",
    },
  ],
};

async function run(docLen: number) {
  const { client, sent } = scriptedClient();
  const doc = docFixture(docLen);
  const gmailPayload = { messages: [{ messageId: "m1", messageText: "x".repeat(30_000) }] };
  const result = await runStatelessAgentTurn({
    orgId: "org-1",
    orgSlug: "org",
    orgName: "Org",
    soul: null,
    timezone: "UTC",
    blueprint,
    messages: [{ role: "user", content: "read the doc and my email" }],
    testMode: true,
    client,
    now: new Date("2026-10-21T00:00:00Z"),
    wrapToolCall: async (tool) => (tool === DOC ? doc : gmailPayload) as never,
  });
  return { result, sent, doc, gmailPayload };
}

describe("stateless turn: per-tool result cap reaches the model", () => {
  test("a 72,097-char Doc read reaches the model COMPLETE; Gmail stays capped at 20k with the notice", async () => {
    const { result, sent, doc, gmailPayload } = await run(72_097);
    assert.equal(result.ok, true);
    const docContent = toolResultContent(sent, "t1");
    assert.equal(docContent, JSON.stringify(doc));
    assert.ok(docContent.includes("## FINAL SECTION"));
    assert.ok(!docContent.includes("tool result truncated"));
    const gmailContent = toolResultContent(sent, "t2");
    assert.ok(gmailContent.includes(`showing 20000 of ${JSON.stringify(gmailPayload).length} chars.`));
  });

  test("an over-limit Doc read reaches the model with the explicit truncation notice (never silent)", async () => {
    const { sent, doc } = await run(95_000);
    const docContent = toolResultContent(sent, "t1");
    assert.ok(docContent.includes(`[tool result truncated: showing 80000 of ${JSON.stringify(doc).length} chars.`));
    assert.ok(!docContent.includes("## FINAL SECTION"));
  });
});
