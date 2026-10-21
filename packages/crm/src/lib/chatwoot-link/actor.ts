// Chatwoot customer link: the pure actor rule (testable without a request). session.ts feeds it from the real session.
import { isAdminTokenUserId } from "@/lib/auth/admin-token";
import { isOperatorPortalUserId } from "@/lib/auth/operator-portal-context";

import type { Actor } from "./service";

/** tokenSession: an operator-portal or admin-token context was present (or could not be resolved) in this request. */
export function actorFromSession(s: {
  tokenSession: boolean;
  userId: string | null | undefined;
  orgId: string | null | undefined;
  role: string | null | undefined;
}): Actor | null {
  if (!s.orgId || !s.userId) return null;
  const realPerson = !s.tokenSession && !isAdminTokenUserId(s.userId) && !isOperatorPortalUserId(s.userId);
  return { orgId: s.orgId, userId: s.userId, role: s.role ?? "member", realPerson };
}

/** Whether the page should offer the confirm button. The Server Action re-checks the same rule. */
export const canConfirmChatwootLink = (a: Actor | null) => !!a && a.realPerson && ["owner", "admin"].includes(a.role);
