"use server";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { brainEvents } from "@/db/schema";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { writeEvent } from "@/lib/brain";
import { assertWritable } from "@/lib/demo/server";
import { getPortalSessionForOrg } from "@/lib/portal/auth";
import { requireWorkspaceAdmin } from "@/lib/auth/require-workspace-role";

type RecordSeldonFeedbackResult = {
  ok: boolean;
  error?: string;
};

function normalizeFeedbackScore(value: unknown) {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric > 0) {
    return 1;
  }

  if (numeric < 0) {
    return -1;
  }

  return 0;
}

function toSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function recordSeldonFeedbackAction(formData: FormData): Promise<RecordSeldonFeedbackResult> {
  // EPIC 2026-10-21 (Codex r4): the builder path needs owner/admin; the END-CLIENT path (customer portal chat) is
  // authenticated by the portal session below, so the role guard does not apply to it.
  // Defensive: anything that is not real form data is never end-client mode, so the builder guard applies (fail closed).
  const endClientMode = typeof (formData as { get?: unknown } | null)?.get === "function" && String(formData.get("end_client_mode") ?? "") === "true";
  if (!endClientMode) await requireWorkspaceAdmin();
  assertWritable();
  const orgSlug = String(formData.get("orgSlug") ?? "").trim();
  const sessionId = String(formData.get("sessionId") ?? "").trim();
  const messageId = String(formData.get("messageId") ?? "").trim();
  const normalizedFeedbackScore = normalizeFeedbackScore(formData.get("feedbackScore"));

  if (normalizedFeedbackScore === null) {
    return { ok: false, error: "Invalid feedback score" };
  }

  let orgId: string | null = null;
  let clientId: string | null = null;

  if (endClientMode) {
    const endClientSession = await getPortalSessionForOrg(orgSlug);
    if (!endClientSession) {
      return { ok: false, error: "Unauthorized" };
    }

    orgId = endClientSession.orgId;
    clientId = endClientSession.contact.id;
  } else {
    const user = await getCurrentUser();
    orgId = await getOrgId();

    if (!user?.id || !orgId) {
      return { ok: false, error: "Unauthorized" };
    }
  }

  if (!orgId) {
    return { ok: false, error: "Unauthorized" };
  }

  if (sessionId && messageId) {
    const workspaceHash = toSha256(orgId);
    const sessionHash = toSha256(sessionId);
    const messageHash = toSha256(messageId);

    const [existingFeedback] = await db
      .select({ eventId: brainEvents.eventId })
      .from(brainEvents)
      .where(
        and(
          eq(brainEvents.workspaceId, workspaceHash),
          eq(brainEvents.eventType, "seldon_it_applied"),
          sql`${brainEvents.payload}->>'action' = 'feedback'`,
          sql`${brainEvents.payload}->>'feedback_for_session_id' = ${sessionHash}`,
          sql`${brainEvents.payload}->>'feedback_for_message_id' = ${messageHash}`
        )
      )
      .limit(1);

    if (existingFeedback) {
      console.info("[seldon-feedback] duplicate feedback ignored", {
        sessionId,
        messageId,
        mode: endClientMode ? "end_client" : "builder",
      });
      return { ok: true };
    }
  }

  await writeEvent(orgId, "seldon_it_applied", {
    mode: endClientMode ? "end_client" : "builder",
    client_id: clientId,
    action: "feedback",
    feedback_score: normalizedFeedbackScore,
    feedback_for_session_id: sessionId || null,
    feedback_for_message_id: messageId || null,
  });

  return { ok: true };
}
