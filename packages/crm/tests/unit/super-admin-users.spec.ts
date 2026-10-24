import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEffectiveWorkspaceRole } from "../../src/lib/super-admin/users";

describe("super-admin displays the SeldonFrame effective workspace role", () => {
  test("primary workspace role comes from users.role", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-a", isOwner: true, memberRole: "member",
    }), { effectiveRole: "owner", roleSource: "users.role" });
  });

  test("additional workspace role comes from org_members", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: false, memberRole: "operator",
    }), { effectiveRole: "operator", roleSource: "org_members.role" });
  });

  test("owned workspace without a separate membership falls back to users.role", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: true, memberRole: null,
    }), { effectiveRole: "owner", roleSource: "users.role" });
  });

  test("legacy membership history alone does not claim app access", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: false, memberRole: null,
    }), { effectiveRole: null, roleSource: null });
  });
});
