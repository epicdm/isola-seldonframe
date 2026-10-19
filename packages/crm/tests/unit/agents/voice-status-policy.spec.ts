import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { permitsVoiceStatusForce } from "../../../src/lib/agents/voice-status-policy";

describe("voice status force authorization", () => {
  test("permits force only for the workspace-scoped voice receptionist", () => {
    assert.equal(permitsVoiceStatusForce("voice-receptionist"), true);
    assert.equal(permitsVoiceStatusForce("website-chatbot"), false);
    assert.equal(permitsVoiceStatusForce(undefined), false);
  });
});
