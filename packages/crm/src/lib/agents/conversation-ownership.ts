// 2026-10-19 — conversation ownership guard for caller-supplied conversation ids
// (def-uplink-public-turn-conversation-id-not-bound-to-agent-2026-10-19).
//
// BUG: the public turn route (/api/v1/public/agent/[slug]/turn) accepted any
// `conversation_id` from the caller and handed it to executeTurn, which loads
// the conversation by id alone and then runs the turn as THAT conversation's
// agent. A caller holding another agent's (or another workspace's)
// conversation id could append turns to it and spend that workspace's model
// budget.
//
// FIX: when a route resolves its agent independently of the conversation (the
// public route resolves it from the URL slug), it passes that agent as
// `expectedAgent`, and executeTurn treats a conversation that belongs to a
// different agent or workspace exactly like an unknown id. Same result object,
// so the caller learns nothing about whether the id exists (no oracle).
//
// Pure module — no DB, no IO. runtime.ts is "use server" and may only export
// async functions, so the predicate lives here.

export interface ExpectedConversationOwner {
  agentId: string;
  orgId: string;
}

export interface ConversationOwnerFields {
  agentId: string;
  orgId: string;
}

/** True iff the conversation exists and belongs to the expected agent AND
 *  workspace. With no expectation (internal callers that created or derived
 *  the conversation themselves) any existing conversation is accepted, which
 *  is the unchanged pre-fix behaviour for those callers. */
export function conversationMatchesOwner(
  conv: ConversationOwnerFields | null | undefined,
  expected: ExpectedConversationOwner | undefined,
): boolean {
  if (!conv) return false;
  if (!expected) return true;
  return conv.agentId === expected.agentId && conv.orgId === expected.orgId;
}

/** The single not-found result executeTurn returns for an unknown id AND for
 *  a conversation owned by someone else. One object, so both are identical. */
export const CONVERSATION_NOT_FOUND_RESULT = Object.freeze({
  ok: false as const,
  reason: "conversation_not_found",
  fallbackMessage: "I'm sorry, this chat session has expired. Please refresh the page.",
});
