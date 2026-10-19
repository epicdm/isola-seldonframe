import { NextResponse } from "next/server";

export function publicTurnFallbackResponse(
  conversationId: string,
  result: { reason: string; fallbackMessage: string },
  headers: HeadersInit,
  conversationCapability?: string,
): NextResponse {
  return NextResponse.json(
    {
      conversation_id: conversationId,
      ...(conversationCapability ? { conversation_capability: conversationCapability } : {}),
      message: result.fallbackMessage,
      degraded: true,
      reason: result.reason,
    },
    { headers },
  );
}

export function publicTurnFallbackEvents(
  conversationId: string,
  result: { reason: string; fallbackMessage: string },
  conversationCapability?: string,
) {
  return [
    { event: "delta", data: { text: result.fallbackMessage } },
    {
      event: "done",
      data: {
        conversation_id: conversationId,
        ...(conversationCapability ? { conversation_capability: conversationCapability } : {}),
        degraded: true,
        reason: result.reason,
      },
    },
  ] as const;
}
