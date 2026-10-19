// 2026-05-22 — auto-creator publishes status='live' chatbots (bug fix).
//
// BUG (suspenders half): all three auto-creators were scaffolding the
// website chatbot with `status: "test"`. Combined with the bug in the
// public turn route (Part A) this meant public traffic never produced
// bookings. Even after Part A lands, leaving the agent in test status
// is confusing: the operator dashboard surfaces "test" badges, eval
// gates appear blocking, and a future testMode-by-agent-status reintro
// would resurrect the bug.
//
// FIX (Part B): auto-creators call `autoCreateWebsiteChatbot()` which
// passes `status: "live"` to createAgent. Empty FAQ is expected for a
// freshly-scaffolded chatbot — the eval gate at store.ts:285-303 only
// runs in publishAgent's draft|test|paused → live transitions, NOT in
// createAgent. So passing status="live" up-front is the cleanest path.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  autoCreateWebsiteChatbot,
  type AutoCreateChatbotDeps,
  type AutoCreateChatbotResult,
} from "../../src/lib/agents/auto-create-website-chatbot";
import type { CreateAgentInput, CreateAgentResult } from "../../src/lib/agents/store";

type CapturedCreate = { input: CreateAgentInput; calls: number };
type CapturedEmbed = { args: { orgId: string; embedUrl: string; agentId: string } | null; calls: number };

function makeMockDeps(): {
  deps: AutoCreateChatbotDeps;
  created: CapturedCreate;
  embed: CapturedEmbed;
} {
  const created: CapturedCreate = { input: null as unknown as CreateAgentInput, calls: 0 };
  const embed: CapturedEmbed = { args: null, calls: 0 };

  const deps: AutoCreateChatbotDeps = {
    createAgent: async (input: CreateAgentInput): Promise<CreateAgentResult> => {
      created.input = input;
      created.calls += 1;
      return {
        ok: true,
        agent: {
          id: "agent_test_1",
          orgId: input.orgId,
          name: input.name,
          slug: "default",
          channel: input.channel,
          archetype: input.archetype,
          status: input.status ?? "draft",
          // Other fields the store returns — fill with sentinels.
          blueprint: {} as never,
          currentVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        embedUrl: "https://app.seldonframe.com/api/v1/public/agent/acme--default/embed.js",
        turnUrl: "https://app.seldonframe.com/api/v1/public/agent/acme--default/turn",
      };
    },
    setPublicChatbotEmbed: async (orgId, args) => {
      embed.args = { orgId, ...args };
      embed.calls += 1;
    },
  };

  return { deps, created, embed };
}

describe("autoCreateWebsiteChatbot — Part B bug fix", () => {
  test("creates agent with status='live' (THE BUG FIX)", async () => {
    // Pre-fix: all three auto-creators passed status="test". Post-fix:
    // auto-created chatbots ship at status="live" so the public turn
    // route writes `agent_conversations.status = "active"` and bookings
    // persist.
    const { deps, created } = makeMockDeps();

    const result = await autoCreateWebsiteChatbot({
      workspaceId: "org_acme",
      workspaceSlug: "acme",
      deps,
    });

    assert.equal(created.calls, 1, "createAgent must be called exactly once");
    assert.equal(created.input.status, "live", "auto-created chatbot must be status='live'");
    assert.equal(result.ok, true);
  });

  test("setPublicChatbotEmbed is still called with the new agent", async () => {
    // Embed publishing must continue to work after the status change —
    // otherwise the public R landing route stops rendering the chatbot
    // bubble even though the agent exists.
    const { deps, embed } = makeMockDeps();

    const result = await autoCreateWebsiteChatbot({
      workspaceId: "org_acme",
      workspaceSlug: "acme",
      deps,
    });

    assert.equal(embed.calls, 1, "setPublicChatbotEmbed must be called");
    assert.equal(embed.args?.orgId, "org_acme");
    assert.equal(embed.args?.agentId, "agent_test_1");
    assert.equal(
      embed.args?.embedUrl,
      "https://app.seldonframe.com/api/v1/public/agent/acme--default/embed.js",
    );
    assert.equal(result.ok, true);
  });

  test("passes archetype + channel + name correctly to createAgent", async () => {
    const { deps, created } = makeMockDeps();

    await autoCreateWebsiteChatbot({
      workspaceId: "org_xyz",
      workspaceSlug: "ignitify-cooling",
      deps,
    });

    assert.equal(created.input.orgId, "org_xyz");
    assert.equal(created.input.archetype, "website-chatbot");
    assert.equal(created.input.channel, "web_chat");
    assert.equal(created.input.name, "ignitify-cooling Chatbot");
    assert.deepEqual(created.input.faq, []);
  });

  test("when createAgent fails, embed is NOT published (no orphan embed)", async () => {
    // Defensive: a failed agent create shouldn't write a dangling embed
    // record pointing at a non-existent agent id.
    const embed: CapturedEmbed = { args: null, calls: 0 };
    const deps: AutoCreateChatbotDeps = {
      createAgent: async () => ({
        ok: false,
        error: "validation_failed",
        validation_errors: ["name must be at least 2 chars"],
      }),
      setPublicChatbotEmbed: async (orgId, args) => {
        embed.args = { orgId, ...args };
        embed.calls += 1;
      },
    };

    const result = await autoCreateWebsiteChatbot({
      workspaceId: "org_acme",
      workspaceSlug: "acme",
      deps,
    });

    assert.equal(result.ok, false);
    assert.equal(embed.calls, 0, "setPublicChatbotEmbed must NOT be called on failure");
  });

  test("embed publish failure does not fail the overall operation", async () => {
    // setPublicChatbotEmbed is best-effort — historically wrapped in
    // try/catch in each route. Preserve that semantic in the extracted
    // helper.
    const deps: AutoCreateChatbotDeps = {
      createAgent: async (input) => ({
        ok: true,
        agent: {
          id: "agent_test_1",
          orgId: input.orgId,
          name: input.name,
          slug: "default",
          channel: input.channel,
          archetype: input.archetype,
          status: "live",
          blueprint: {} as never,
          currentVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        embedUrl: "https://x.example/embed.js",
        turnUrl: "https://x.example/turn",
      }),
      setPublicChatbotEmbed: async () => {
        throw new Error("simulated DB outage");
      },
    };

    const result: AutoCreateChatbotResult = await autoCreateWebsiteChatbot({
      workspaceId: "org_acme",
      workspaceSlug: "acme",
      deps,
    });

    // Helper still reports OK — the agent exists, only the embed publish
    // failed; an operator can re-run embed_chatbot_on_workspace_landing
    // manually to recover.
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.embedPublishFailed, true);
    }
  });
});

describe("autoCreateWebsiteChatbot — status policy closes public inference on the file-provider deployment (wizard hotfix)", () => {
  const KEYS = ["SF_WIZARD_CHATBOT_STATUS", "MODEL_API_KEY_FILE", "ANTHROPIC_API_KEY"] as const;
  const run = async (set: Partial<Record<(typeof KEYS)[number], string>>) => {
    const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(set)) process.env[k] = v as string;
    try {
      const { deps, created } = makeMockDeps();
      await autoCreateWebsiteChatbot({ workspaceId: "org_acme", workspaceSlug: "acme", deps });
      return created.input.status;
    } finally {
      for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] as string; }
    }
  };

  test("no provider configuration keeps the historical status='live' (control: the policy is not global)", async () => {
    assert.equal(await run({}), "live");
  });

  test("mounted-file managed AI (MODEL_API_KEY_FILE, no ANTHROPIC_API_KEY) -> status='test' (not publicly served)", async () => {
    assert.equal(await run({ MODEL_API_KEY_FILE: "/run/key" }), "test");
  });

  test("ANTHROPIC_API_KEY present (the other managed-AI mode) keeps 'live' even if a key file is also set (same precedence as getAIClient)", async () => {
    assert.equal(await run({ MODEL_API_KEY_FILE: "/run/key", ANTHROPIC_API_KEY: "sk-ant-synthetic" }), "live");
  });

  test("explicit SF_WIZARD_CHATBOT_STATUS wins in both directions; garbage values fall back to the provider-based default", async () => {
    assert.equal(await run({ SF_WIZARD_CHATBOT_STATUS: "live", MODEL_API_KEY_FILE: "/run/key" }), "live");
    assert.equal(await run({ SF_WIZARD_CHATBOT_STATUS: "test" }), "test");
    assert.equal(await run({ SF_WIZARD_CHATBOT_STATUS: "TEST", MODEL_API_KEY_FILE: "/run/key" }), "test");
    assert.equal(await run({ SF_WIZARD_CHATBOT_STATUS: "paused" }), "live");
  });
});
