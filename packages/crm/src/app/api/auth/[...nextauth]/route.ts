import { handlers } from "@/auth";
import { NextRequest } from "next/server";
import { logAuthRequestPath } from "@/lib/auth/request-log";

export async function GET(req: NextRequest) {
  logAuthRequestPath("GET", req);
  if (req.nextUrl.pathname === "/api/auth/callback/google") {
    const pkceCookie = req.cookies.get("__Secure-authjs.pkce.code_verifier") ?? req.cookies.get("authjs.pkce.code_verifier");
    console.log("[auth][route] callback params", {
      hasCode: req.nextUrl.searchParams.has("code"),
      hasState: req.nextUrl.searchParams.has("state"),
      hasIss: req.nextUrl.searchParams.has("iss"),
    });
    console.log("[auth][route] callback pkce cookie", {
      present: Boolean(pkceCookie?.value),
      length: pkceCookie?.value?.length ?? 0,
    });
  }
  const resp = await handlers.GET(req);
  console.log("[auth][route] GET status", resp?.status);
  return resp;
}

export async function POST(req: NextRequest) {
  logAuthRequestPath("POST", req);
  const resp = await handlers.POST(req);
  console.log("[auth][route] POST status", resp?.status);
  return resp;
}
