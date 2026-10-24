"use server";

// Chatwoot customer link: the two Server Actions the contact page calls. Each derives the workspace, user and role from the SESSION (never
// from the request; see session.ts for mixed sessions) and then runs the injectable core in service.ts. No token, Chatwoot URL with
// credentials, or raw Chatwoot payload is ever returned to the browser.
import { assertWritable } from "@/lib/demo/server";
import { getCurrentWorkspaceRole } from "@/lib/auth/helpers";

import { confirmChatwootLink, findChatwootCandidates, type ConfirmResult, type FindResult } from "./service";
import { resolveChatwootActor } from "./session";
import { makeChatwootLinkDeps } from "./wiring";

async function requireWorkspaceAdmin(): Promise<void> {
  const role = await getCurrentWorkspaceRole();
  if (role !== "owner" && role !== "admin") throw new Error("workspace_role_forbidden");
}

export async function findChatwootCandidatesAction(contactId: string): Promise<FindResult> {
  // EPIC 2026-10-21 (staff access): only owner/admin can confirm a link, and the card that calls this is offered only to them,
  // so the Chatwoot lookup is owner/admin as well. The workspace role is re-read per request (lib/auth/workspace-role.ts).
  await requireWorkspaceAdmin();
  const actor = await resolveChatwootActor();
  if (!actor) return { ok: false, code: "not_found" };
  return findChatwootCandidates(actor, String(contactId ?? ""), makeChatwootLinkDeps(actor.orgId));
}

export async function confirmChatwootLinkAction(input: { contactId: string; chatwootContactId: number; conversationId: number }): Promise<ConfirmResult> {
  // EPIC 2026-10-21 (staff access): owner/admin first (a staff caller gets the role refusal); the service then applies its own
  // stricter rule (real person, owner/admin) exactly as before.
  await requireWorkspaceAdmin();
  assertWritable();
  const actor = await resolveChatwootActor();
  if (!actor) return { ok: false, code: "forbidden" };
  const i = (input ?? {}) as Record<string, unknown>;
  return confirmChatwootLink(actor, { contactId: i.contactId, chatwootContactId: i.chatwootContactId, conversationId: i.conversationId }, makeChatwootLinkDeps(actor.orgId));
}
