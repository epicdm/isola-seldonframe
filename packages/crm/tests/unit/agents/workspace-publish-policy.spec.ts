import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceForcePublishDenied } from "../../../src/lib/agents/workspace-publish-policy";

describe("workspace publish authorization", () => {
  test("rejects an explicit force bypass from workspace credentials", () => {
    assert.equal(isWorkspaceForcePublishDenied(true), true);
  });

  test("keeps ordinary publish requests on the normal evaluation-gated path", () => {
    assert.equal(isWorkspaceForcePublishDenied(undefined), false);
    assert.equal(isWorkspaceForcePublishDenied(false), false);
  });

  test("does not treat truthy non-boolean payloads as an authorized force option", () => {
    assert.equal(isWorkspaceForcePublishDenied("true"), false);
    assert.equal(isWorkspaceForcePublishDenied(1), false);
  });
});
