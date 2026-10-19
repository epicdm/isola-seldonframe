import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canAccessAgentTurn } from "../../../src/lib/agents/public-agent-access";

describe("public agent turn access", () => {
  it("refuses anonymous access to test and draft agents", () => {
    assert.equal(canAccessAgentTurn("test", false), false);
    assert.equal(canAccessAgentTurn("draft", false), false);
    assert.equal(canAccessAgentTurn("paused", false), false);
  });

  it("serves only live agents to ordinary public callers", () => {
    assert.equal(canAccessAgentTurn("live", false), true);
  });

  it("retains native test-mode access for an authenticated same-workspace operator", () => {
    assert.equal(canAccessAgentTurn("test", true), true);
    assert.equal(canAccessAgentTurn("live", true), true);
  });

  it("requires a validated same-workspace operator session for test-mode access", () => {
    assert.equal(canAccessAgentTurn("test", false), false);
  });
});
