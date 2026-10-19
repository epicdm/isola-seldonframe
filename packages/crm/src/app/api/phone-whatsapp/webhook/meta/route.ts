// GET/POST /api/phone-whatsapp/webhook/meta — Meta's webhook for COEXISTENCE numbers (the phone-level override set at connect). Public by
// necessity (Meta calls it); every POST must carry a valid X-Hub-Signature-256 for META_APP_SECRET. Messages, echoes and calls are forwarded
// byte-identical (signature header preserved) to the bound Chatwoot inbox, the number's single message processor; history and contacts are
// digested into that inbox. The workspace and inbox come only from our own binding of the phone number id. See lib/.../connect/receiver.ts.
import { NextResponse } from "next/server";

import { makeChatwootClient } from "@/lib/phone-whatsapp/connect/chatwoot-client";
import { handleReceiverPost, handleReceiverVerify } from "@/lib/phone-whatsapp/connect/receiver";
import { findCoexBindings, historyChunkSeen, markHistoryChunk } from "@/lib/phone-whatsapp/connect/server-wiring";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const r = handleReceiverVerify(new URL(req.url).searchParams, (process.env.PHONE_COEX_RECEIVER_VERIFY_TOKEN ?? "").trim());
  return new NextResponse(r.text, { status: r.status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const apiBase = (process.env.PHONE_COEX_CHATWOOT_API_BASE ?? "").trim().replace(/\/+$/, "");
  const apiToken = (process.env.PHONE_COEX_CHATWOOT_API_TOKEN ?? "").trim();
  const r = await handleReceiverPost(raw, req.headers.get("x-hub-signature-256"), {
    appSecret: (process.env.META_APP_SECRET ?? "").trim(),
    lookup: findCoexBindings,
    async forward(url, body, headers) {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      return res.status;
    },
    chatwootFor: (b) => makeChatwootClient({ base: apiBase, accountId: b.chatwootAccountId, apiToken }),
    seen: historyChunkSeen,
    async mark(orgId, phone, key) { await markHistoryChunk(orgId, phone, key); },
    log: (l) => console.log(l),
  }).catch((e) => {
    console.error("[coex-recv] failed:", e instanceof Error ? e.name : "unknown");
    return { status: 500, body: { ok: false, code: "error" } as Record<string, unknown> };
  });
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
