"use server";

// Chatwoot customer link: the two Server Actions the contact page calls. Each derives the workspace, user and role from the SESSION (never
// from the request) and then runs the injectable core in service.ts. No token, Chatwoot URL with credentials, or raw Chatwoot payload is
// ever returned to the browser.
import { getCurrentUser, getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { isAdminTokenUserId } from "@/lib/auth/admin-token";
import { isOperatorPortalUserId } from "@/lib/auth/operator-portal-context";
import { assertWritable } from "@/lib/demo/server";

import { confirmChatwootLink, findChatwootCandidates, type Actor, type ConfirmResult, type FindResult } from "./service";
import { makeChatwootLinkDeps } from "./wiring";

async function sessionActor(): Promise<Actor | null> {
  const [orgId, user] = await Promise.all([getOrgId(), getCurrentUser()]);
  if (!orgId || !user?.id) return null;
  const role = (await getCurrentWorkspaceRole()) ?? "member";
  return { orgId, userId: user.id, role, realPerson: !isAdminTokenUserId(user.id) && !isOperatorPortalUserId(user.id) };
}

export async function findChatwootCandidatesAction(contactId: string): Promise<FindResult> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, code: "not_found" };
  return findChatwootCandidates(actor, String(contactId ?? ""), makeChatwootLinkDeps(actor.orgId));
}

export async function confirmChatwootLinkAction(input: { contactId: string; chatwootContactId: number; conversationId: number }): Promise<ConfirmResult> {
  assertWritable();
  const actor = await sessionActor();
  if (!actor) return { ok: false, code: "forbidden" };
  const i = (input ?? {}) as Record<string, unknown>;
  return confirmChatwootLink(actor, { contactId: i.contactId, chatwootContactId: i.chatwootContactId, conversationId: i.conversationId }, makeChatwootLinkDeps(actor.orgId));
}
