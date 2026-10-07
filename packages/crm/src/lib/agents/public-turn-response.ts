import { NextResponse } from "next/server";

export function publicTurnFallbackResponse(
  conversationId: string,
  result: { reason: string; fallbackMessage: string },
  headers: HeadersInit,
): NextResponse {
  return NextResponse.json(
    {
      conversation_id: conversationId,
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
) {
  return [
    { event: "delta", data: { text: result.fallbackMessage } },
    {
      event: "done",
      data: { conversation_id: conversationId, degraded: true, reason: result.reason },
    },
  ] as const;
}
