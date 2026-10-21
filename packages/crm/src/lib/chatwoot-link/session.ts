// Chatwoot customer link: who is acting. Shared by the contact page (whether to offer "confirm") and both Server Actions, so the two can
// never disagree. NOT a "use server" module: nothing here is callable from the browser.
//
// The session can be MIXED: getOrgId() prefers an operator-portal or admin-token cookie, while getCurrentUser() prefers NextAuth, so with
// both present the workspace can come from the token and the user from NextAuth (Codex review 2026-10-21). Reads stay scoped to the
// workspace getOrgId() returns, which is what every other page in the app does. Confirming is stricter: it is refused whenever ANY token
// context is present, so the workspace and the confirming person are always resolved from the same NextAuth session.
import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { resolveAdminTokenContext } from "@/lib/auth/admin-token";
import { resolveOperatorPortalContext } from "@/lib/auth/operator-portal-context";

import { actorFromSession } from "./actor";
import type { Actor } from "./service";

export { canConfirmChatwootLink } from "./actor";

export type SessionSources = {
  operatorPortal: () => Promise<unknown>;
  adminToken: () => Promise<unknown>;
  orgId: () => Promise<string | null>;
  user: () => Promise<{ id?: string | null } | null | undefined>;
  role: () => Promise<string | null>;
};

const REAL_SOURCES: SessionSources = {
  operatorPortal: resolveOperatorPortalContext,
  adminToken: resolveAdminTokenContext,
  orgId: getOrgId,
  user: getCurrentUser,
  role: getCurrentWorkspaceRole,
};

export async function resolveChatwootActor(src: SessionSources = REAL_SOURCES): Promise<Actor | null> {
  const [opCtx, adminCtx] = await Promise.all([
    src.operatorPortal().catch(() => "error" as const),
    src.adminToken().catch(() => "error" as const),
  ]);
  const [orgId, user] = await Promise.all([src.orgId(), src.user()]);
  const role = orgId && user?.id ? await src.role() : null;
  // A token context that could not even be resolved counts as present: confirmation fails closed.
  return actorFromSession({ tokenSession: opCtx !== null || adminCtx !== null, userId: user?.id, orgId, role });
}
