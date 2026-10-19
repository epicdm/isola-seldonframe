// EPIC 2026-10-16: the improve loop may run on the self-hosted file provider (DeepSeek); the Studio BYOK rule is unchanged.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveImproveGate } from "@/lib/agents/improve/improve-gate";
import { resolveStudioBuildGate } from "@/lib/agent-templates/studio-build-gate";

const FILE_PROVIDER = { MODEL_API_KEY_FILE: "/run/secrets/model_key", MODEL_BASE_URL: "https://api.deepseek.com/anthropic" };
const ANTHROPIC_PLATFORM = { ANTHROPIC_API_KEY: "x" };

describe("resolveImproveGate", () => {
  test("self-hosted file provider: the platform client may run the improve loop (included and metered)", () => {
    assert.deepEqual(resolveImproveGate("included", true, FILE_PROVIDER), { ok: true, via: "platform-file-provider" });
    assert.deepEqual(resolveImproveGate("metered", true, FILE_PROVIDER), { ok: true, via: "platform-file-provider" });
  });
  test("BYOK still passes everywhere (control)", () => {
    assert.deepEqual(resolveImproveGate("byok", true, {}), { ok: true, via: "byok" });
  });
  test("a SaaS platform key (ANTHROPIC_API_KEY) or no provider keeps the Studio rule: platform modes refused", () => {
    assert.deepEqual(resolveImproveGate("included", true, ANTHROPIC_PLATFORM), { ok: false });
    assert.deepEqual(resolveImproveGate("included", true, { ...FILE_PROVIDER, ...ANTHROPIC_PLATFORM }), { ok: false });
    assert.deepEqual(resolveImproveGate("metered", true, {}), { ok: false });
  });
  test("no client never passes, even on the file provider or with BYOK", () => {
    assert.deepEqual(resolveImproveGate("included", false, FILE_PROVIDER), { ok: false });
    assert.deepEqual(resolveImproveGate("byok", false, {}), { ok: false });
  });
  test("CONTROL: the Studio build gate itself is unchanged (platform modes still need BYOK)", () => {
    assert.deepEqual(resolveStudioBuildGate("included"), { ok: false, error: "needs_byok" });
    assert.deepEqual(resolveStudioBuildGate("byok"), { ok: true });
  });
});
