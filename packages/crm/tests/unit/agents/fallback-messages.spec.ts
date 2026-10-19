import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_NOT_FOUND_FALLBACK,
  PROVIDER_NOT_CONFIGURED_FALLBACK,
  TEMPORARY_RUNTIME_ERROR_FALLBACK,
  WORKSPACE_NOT_FOUND_FALLBACK,
} from "../../../src/lib/agents/fallback-messages";
import { selectFinalFallback } from "../../../src/lib/agents/fallbacks";

test("unavailable-agent fallbacks do not promise unsupported contact or handoff", () => {
  for (const message of [
    AGENT_NOT_FOUND_FALLBACK,
    PROVIDER_NOT_CONFIGURED_FALLBACK,
    TEMPORARY_RUNTIME_ERROR_FALLBACK,
    WORKSPACE_NOT_FOUND_FALLBACK,
  ]) {
    assert.doesNotMatch(message, /contact us|reach out|follow up|someone will|send (?:us|me) (?:an )?email|whatsapp/i);
  }
});

test("agent runtime uses the reviewed fixed fallbacks", () => {
  const runtime = readFileSync(path.resolve(__dirname, "../../../src/lib/agents/runtime.ts"), "utf8");
  assert.match(runtime, /fallbackMessage:\s*AGENT_NOT_FOUND_FALLBACK/);
  assert.match(runtime, /fallbackMessage:\s*WORKSPACE_NOT_FOUND_FALLBACK/);
  assert.match(runtime, /fallbackMessage:\s*PROVIDER_NOT_CONFIGURED_FALLBACK/);
  assert.match(runtime, /:\s*TEMPORARY_RUNTIME_ERROR_FALLBACK/);
  assert.doesNotMatch(runtime, /Please reach out directly|someone follow up with you/);
});

test("critical-validator failure does not claim a human handoff or callback", () => {
  const message = selectFinalFallback(["quotes_only_from_soul_pricing"]);
  assert.match(message, /can't verify that answer right now/i);
  assert.match(message, /support contact shown on this page/i);
  assert.doesNotMatch(message, /someone (?:will|is going to)|follow up|team has been notified|we've forwarded/i);
});
