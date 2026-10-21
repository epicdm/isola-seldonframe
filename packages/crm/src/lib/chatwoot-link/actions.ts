"use server";

// Chatwoot customer link: the two Server Actions the contact page calls. Each derives the workspace, user and role from the SESSION (never
// from the request; see session.ts for mixed sessions) and then runs the injectable core in service.ts. No token, Chatwoot URL with
// credentials, or raw Chatwoot payload is ever returned to the browser.
import { assertWritable } from "@/lib/demo/server";

import { confirmChatwootLink, findChatwootCandidates, type ConfirmResult, type FindResult } from "./service";
import { resolveChatwootActor } from "./session";
import { makeChatwootLinkDeps } from "./wiring";

export async function findChatwootCandidatesAction(contactId: string): Promise<FindResult> {
  const actor = await resolveChatwootActor();
  if (!actor) return { ok: false, code: "not_found" };
  return findChatwootCandidates(actor, String(contactId ?? ""), makeChatwootLinkDeps(actor.orgId));
}

export async function confirmChatwootLinkAction(input: { contactId: string; chatwootContactId: number; conversationId: number }): Promise<ConfirmResult> {
  assertWritable();
  const actor = await resolveChatwootActor();
  if (!actor) return { ok: false, code: "forbidden" };
  const i = (input ?? {}) as Record<string, unknown>;
  return confirmChatwootLink(actor, { contactId: i.contactId, chatwootContactId: i.chatwootContactId, conversationId: i.conversationId }, makeChatwootLinkDeps(actor.orgId));
}
