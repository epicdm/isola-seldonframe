import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEffectiveWorkspaceRole } from "../../src/lib/super-admin/users";

describe("super-admin displays the SeldonFrame effective workspace role", () => {
  test("direct workspace ownership wins over a conflicting membership and primary role", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-a", userId: "user-1", ownerId: "user-1", parentUserId: null, agencyOwnerUserId: null,
      membershipRole: "staff", homeOrgId: "org-a", homeRole: "staff",
    }), { effectiveRole: "owner", roleSource: "organizations.owner_id" });
  });

  test("native admin membership is reported as admin", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-b", userId: "user-1", ownerId: null, parentUserId: null, agencyOwnerUserId: null,
      membershipRole: "admin", homeOrgId: "org-a", homeRole: "owner",
    }), { effectiveRole: "admin", roleSource: "org_members.role" });
  });

  test("staff and legacy member grants resolve to staff", () => {
    for (const memberRole of ["staff", "member"]) {
      assert.deepEqual(resolveEffectiveWorkspaceRole({
        orgId: "org-b", userId: "user-1", ownerId: null, parentUserId: null, agencyOwnerUserId: null,
        membershipRole: memberRole, homeOrgId: "org-a", homeRole: "owner",
      }), { effectiveRole: "staff", roleSource: "org_members.role" });
    }
  });

  test("primary workspace owner role remains a valid legacy grant", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-a", userId: "user-1", ownerId: null, parentUserId: null, agencyOwnerUserId: null,
      membershipRole: null, homeOrgId: "org-a", homeRole: "owner",
    }), { effectiveRole: "owner", roleSource: "users.role" });
  });

  test("delegated workspace ownership is resolved through the native resolver", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-b", userId: "user-1", ownerId: null, parentUserId: null, agencyOwnerUserId: "user-1",
      membershipRole: null, homeOrgId: "org-a", homeRole: "owner",
    }), { effectiveRole: "owner", roleSource: "partner_agencies.owner_user_id" });
  });

  test("workspace parent operator role uses its existing ownership path", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-b", userId: "user-1", ownerId: null, parentUserId: "user-1", agencyOwnerUserId: null,
      membershipRole: null, homeOrgId: "org-a", homeRole: "staff",
    }), { effectiveRole: "owner", roleSource: "organizations.parent_user_id" });
  });

  test("unknown membership role fails closed", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-b", userId: "user-1", ownerId: null, parentUserId: null, agencyOwnerUserId: null,
      membershipRole: "operator", homeOrgId: "org-a", homeRole: "owner",
    }), { effectiveRole: null, roleSource: null });
  });

  test("legacy membership history alone does not claim app access", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-b", userId: "user-1", ownerId: null, parentUserId: null, agencyOwnerUserId: null,
      membershipRole: null, homeOrgId: "org-a", homeRole: "owner",
    }), { effectiveRole: null, roleSource: null });
  });

  test("an unknown caller never receives a role", () => {
    assert.deepEqual(resolveEffectiveWorkspaceRole({
      orgId: "org-a", userId: null, ownerId: "user-1", parentUserId: null, agencyOwnerUserId: null,
      membershipRole: null, homeOrgId: "org-a", homeRole: "owner",
    }), { effectiveRole: null, roleSource: null });
  });
});
