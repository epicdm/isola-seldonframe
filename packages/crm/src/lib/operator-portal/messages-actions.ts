// src/lib/operator-portal/messages-actions.ts
"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { requireOperatorSessionForOrg } from "./auth";
import { getOutboundSmsEnabled } from "./outbound-sms-flag";
import { addThreadNote, markThreadRead } from "./messages";
import { sendSmsFromApi } from "@/lib/sms/api";

// A contact id from the client is only used when it belongs to the session's
// workspace; another workspace's id is refused exactly like a missing one.
async function contactInOrg(orgId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
    .limit(1);
  return Boolean(row);
}

export type SendReplyResult =
  | { ok: true }
  | { ok: false; error: string };

export async function sendReplyAction(params: {
  orgSlug: string;
  contactId: string;
  toNumber: string;
  body: string;
}): Promise<SendReplyResult> {
  const session = await requireOperatorSessionForOrg(params.orgSlug);
  const orgId = session.orgId;

  const enabled = await getOutboundSmsEnabled(orgId);
  if (!enabled) {
    return { ok: false, error: "outbound_sms_not_enabled" };
  }
  if (!(await contactInOrg(orgId, params.contactId))) {
    return { ok: false, error: "contact_not_found" };
  }

  try {
    await sendSmsFromApi({
      orgId,
      userId: null,
      contactId: params.contactId,
      toNumber: params.toNumber,
      body: params.body,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Send failed";
    return { ok: false, error: message };
  }
}

export async function addNoteAction(params: {
  orgSlug: string;
  contactId: string;
  body: string;
}): Promise<{ ok: true; noteId: string } | { ok: false; error: string }> {
  const session = await requireOperatorSessionForOrg(params.orgSlug);

  if (!params.body.trim()) {
    return { ok: false, error: "Note body is required" };
  }
  if (!(await contactInOrg(session.orgId, params.contactId))) {
    return { ok: false, error: "Contact not found" };
  }

  try {
    const note = await addThreadNote({
      orgId: session.orgId,
      contactId: params.contactId,
      authorEmail: session.email,
      body: params.body,
    });
    return { ok: true, noteId: note.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save note";
    return { ok: false, error: message };
  }
}

export async function markReadAction(params: {
  orgSlug: string;
  contactId: string;
}): Promise<void> {
  const session = await requireOperatorSessionForOrg(params.orgSlug);
  await markThreadRead({ orgId: session.orgId, contactId: params.contactId });
}
