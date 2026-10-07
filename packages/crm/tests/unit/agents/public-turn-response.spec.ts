import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_NOT_CONFIGURED_FALLBACK } from "../../../src/lib/agents/fallback-messages";
import { createPlatformFileBackedClientOrNull } from "../../../src/lib/ai/platform-client";
import { publicTurnFallbackEvents, publicTurnFallbackResponse } from "../../../src/lib/agents/public-turn-response";

test("public turn returns the safe setup message instead of an HTTP 500 for unavailable provider credentials", async () => {
  const response = publicTurnFallbackResponse(
    "synthetic-conversation",
    { reason: "llm_not_configured", fallbackMessage: PROVIDER_NOT_CONFIGURED_FALLBACK },
    new Headers({ "Access-Control-Allow-Origin": "*" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), {
    conversation_id: "synthetic-conversation",
    message: "I'm not set up to chat yet. The team is finishing my configuration. Please try again later.",
    degraded: true,
    reason: "llm_not_configured",
  });
  assert.deepEqual(publicTurnFallbackEvents("synthetic-conversation", {
    reason: "llm_not_configured",
    fallbackMessage: PROVIDER_NOT_CONFIGURED_FALLBACK,
  }), [
    { event: "delta", data: { text: PROVIDER_NOT_CONFIGURED_FALLBACK } },
    { event: "done", data: { conversation_id: "synthetic-conversation", degraded: true, reason: "llm_not_configured" } },
  ]);
});

test("missing, empty, and unreadable model-key files reach the safe JSON and SSE public-turn fallback", async () => {
  const readers = [
    async () => { throw new Error("ENOENT /synthetic/private/key"); },
    async () => "\n  ",
    async () => { throw new Error("EACCES /synthetic/private/key"); },
  ];

  for (const readFileValue of readers) {
    const client = await createPlatformFileBackedClientOrNull(
      "/synthetic/private/key",
      "https://model.invalid/v1",
      undefined,
      readFileValue,
    );
    assert.equal(client, null);

    const result = { reason: "llm_not_configured", fallbackMessage: PROVIDER_NOT_CONFIGURED_FALLBACK };
    const response = publicTurnFallbackResponse("synthetic-conversation", result, new Headers());
    assert.equal(response.status, 200);
    const body = await response.json() as { message: string; degraded: boolean; reason: string };
    assert.equal(body.message, PROVIDER_NOT_CONFIGURED_FALLBACK);
    assert.equal(body.degraded, true);
    assert.equal(body.reason, "llm_not_configured");
    assert.equal(JSON.stringify(body).includes("/synthetic/private/key"), false);
    assert.equal(publicTurnFallbackEvents("synthetic-conversation", result)[0].data.text, PROVIDER_NOT_CONFIGURED_FALLBACK);
  }
});
