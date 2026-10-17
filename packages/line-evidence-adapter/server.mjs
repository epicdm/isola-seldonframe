// line-evidence adapter HTTP surface. One route, GET only, bearer-token protected, fail-closed on missing config.
//   GET /v1/lines/:phoneNumberId?waba=<wabaId>     -> line-evidence/v1
//   GET /healthz                                   -> {ok:true}   (no upstream calls)
// Env (names only; values come from the runtime secret mount): ADAPTER_TOKEN (>= 24 chars), META_WA_TOKEN, MAGNUS_URL,
// MAGNUS_API_KEY, MAGNUS_API_SECRET; optional META_API_BASE, PORT, BIND, EVIDENCE_CACHE_SECONDS, EVIDENCE_RPM.
import http from "node:http";
import crypto from "node:crypto";
import { collectLineEvidence, isId } from "./evidence.mjs";

export function configFromEnv(env = process.env) {
  const missing = ["ADAPTER_TOKEN", "META_WA_TOKEN", "MAGNUS_URL", "MAGNUS_API_KEY", "MAGNUS_API_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`refusing to start: missing ${missing.join(", ")}`);
  if (env.ADAPTER_TOKEN.length < 24) throw new Error("refusing to start: ADAPTER_TOKEN shorter than 24 characters");
  return {
    adapterToken: env.ADAPTER_TOKEN,
    metaToken: env.META_WA_TOKEN,
    metaBase: (env.META_API_BASE || "https://graph.facebook.com/v25.0").replace(/\/$/, ""),
    magnusUrl: env.MAGNUS_URL.replace(/\/$/, ""),
    magnusKey: env.MAGNUS_API_KEY,
    magnusSecret: env.MAGNUS_API_SECRET,
    timeoutMs: 12000,
    cacheSeconds: Number(env.EVIDENCE_CACHE_SECONDS ?? 20),
    rpm: Number(env.EVIDENCE_RPM ?? 30),
  };
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function makeHandler(cfg, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map();
  const hits = [];
  return async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
      if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
      const auth = String(req.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ") || !safeEq(auth.slice(7), cfg.adapterToken)) return send(401, { error: "unauthorized" });
      const m = url.pathname.match(/^\/v1\/lines\/([^/]+)$/);
      if (!m) return send(404, { error: "not_found" });
      const phoneNumberId = decodeURIComponent(m[1]);
      const wabaId = url.searchParams.get("waba") ?? "";
      if (!isId(phoneNumberId) || !isId(wabaId)) return send(400, { error: "bad_request" });
      const t = now().getTime();
      while (hits.length && t - hits[0] > 60000) hits.shift();
      const key = `${wabaId}:${phoneNumberId}`;
      const c = cache.get(key);
      if (c && t - c.at < cfg.cacheSeconds * 1000) return send(200, c.body);
      if (hits.length >= cfg.rpm) return send(429, { error: "rate_limited" });
      hits.push(t);
      const body = await collectLineEvidence(cfg, { wabaId, phoneNumberId }, fetchImpl, now);
      cache.set(key, { at: t, body });
      return send(200, body);
    } catch (e) {
      return send(e?.code === "bad_request" ? 400 : 502, { error: e?.code === "bad_request" ? "bad_request" : "upstream_failure" });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
  const cfg = configFromEnv();
  http.createServer(makeHandler(cfg)).listen(Number(process.env.PORT ?? 8787), process.env.BIND ?? "127.0.0.1", () =>
    console.log(`line-evidence adapter listening (read-only); cache ${cfg.cacheSeconds}s, ${cfg.rpm} rpm`));
}
