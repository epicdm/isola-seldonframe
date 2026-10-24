import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEffectiveWorkspaceRole } from "../../src/lib/super-admin/users";

describe("super-admin displays the SeldonFrame effective workspace role", () => {
  test("direct workspace ownership wins over a conflicting membership and primary role", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "staff", workspaceId: "org-a", isOwner: true, memberRole: "staff",
    }), { effectiveRole: "owner", roleSource: "organizations.owner_id" });
  });

  test("native admin membership is reported as admin", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: false, memberRole: "admin",
    }), { effectiveRole: "admin", roleSource: "org_members.role" });
  });

  test("staff and legacy member grants resolve to staff", () => {
    for (const memberRole of ["staff", "member"]) {
      assert.deepEqual(resolveEffectiveWorkspaceRole({
        userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: false, memberRole,
      }), { effectiveRole: "staff", roleSource: "org_members.role" });
    }
  });

  test("primary workspace owner role remains a valid legacy grant", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-a", isOwner: false, memberRole: null,
    }), { effectiveRole: "owner", roleSource: "users.role" });
  });

  test("unknown membership role fails closed", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: false, memberRole: "operator",
    }), { effectiveRole: null, roleSource: null });
  });

  test("legacy membership history alone does not claim app access", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      userId: "user-1", primaryOrgId: "org-a", userRole: "owner", workspaceId: "org-b", isOwner: false, memberRole: null,
    }), { effectiveRole: null, roleSource: null });
  });
});
