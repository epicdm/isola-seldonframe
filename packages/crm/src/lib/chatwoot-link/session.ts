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

export async function resolveChatwootActor(): Promise<Actor | null> {
  const [opCtx, adminCtx] = await Promise.all([
    resolveOperatorPortalContext().catch(() => "error" as const),
    resolveAdminTokenContext().catch(() => "error" as const),
  ]);
  const [orgId, user] = await Promise.all([getOrgId(), getCurrentUser()]);
  const role = orgId && user?.id ? await getCurrentWorkspaceRole() : null;
  // A token context that could not even be resolved counts as present: confirmation fails closed.
  return actorFromSession({ tokenSession: opCtx !== null || adminCtx !== null, userId: user?.id, orgId, role });
}
