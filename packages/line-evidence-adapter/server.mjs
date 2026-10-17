// line-evidence adapter HTTP surface. One route, GET only, bearer-token protected, fail-closed on missing config.
//   GET /v1/lines/:phoneNumberId?waba=<wabaId>     -> line-evidence/v1
//   GET /healthz                                   -> {ok:true}   (no upstream calls)
// Env (names only; values come from the runtime secret mount): ADAPTER_TOKEN (>= 24 chars), META_WA_TOKEN, MAGNUS_URL,
// MAGNUS_API_KEY, MAGNUS_API_SECRET; optional META_API_BASE, PORT, BIND, EVIDENCE_CACHE_SECONDS, EVIDENCE_RPM.
import http from "node:http";
import crypto from "node:crypto";
import { collectLineEvidence, isId } from "./evidence.mjs";

export function configFromEnv(env = process.env) {
  // Magnus access mode. "sql" (default) = a SELECT-only database account, enforced by the database. "rest" = the Magnus API key,
  // which is write-capable on the server side and is for preview only. The two never mix: in sql mode a REST key must be ABSENT.
  const mode = (env.MAGNUS_MODE || "sql").toLowerCase();
  if (mode !== "sql" && mode !== "rest") throw new Error("refusing to start: MAGNUS_MODE must be sql or rest");
  const magnusVars = mode === "sql" ? ["MAGNUS_DB_HOST", "MAGNUS_DB_USER", "MAGNUS_DB_PASSWORD"] : ["MAGNUS_URL", "MAGNUS_API_KEY", "MAGNUS_API_SECRET"];
  const missing = ["ADAPTER_TOKEN", "META_WA_TOKEN", ...magnusVars].filter((k) => !env[k]);
  if (missing.length) throw new Error(`refusing to start: missing ${missing.join(", ")}`);
  if (env.ADAPTER_TOKEN.length < 24) throw new Error("refusing to start: ADAPTER_TOKEN shorter than 24 characters");
  if (mode === "sql" && (env.MAGNUS_API_KEY || env.MAGNUS_API_SECRET)) throw new Error("refusing to start: a Magnus API key is present in sql mode (a write-capable credential must not be in this service)");
  if (mode === "sql" && /^(root|mbillingUser)$/i.test(env.MAGNUS_DB_USER)) throw new Error("refusing to start: MAGNUS_DB_USER must be the dedicated SELECT-only account");
  return {
    adapterToken: env.ADAPTER_TOKEN,
    metaToken: env.META_WA_TOKEN,
    metaBase: (env.META_API_BASE || "https://graph.facebook.com/v25.0").replace(/\/$/, ""),
    magnusMode: mode,
    magnusUrl: mode === "rest" ? env.MAGNUS_URL.replace(/\/$/, "") : undefined,
    magnusKey: mode === "rest" ? env.MAGNUS_API_KEY : undefined,
    magnusSecret: mode === "rest" ? env.MAGNUS_API_SECRET : undefined,
    magnusDb: mode === "sql" ? { host: env.MAGNUS_DB_HOST, port: Number(env.MAGNUS_DB_PORT || 3306), user: env.MAGNUS_DB_USER, password: env.MAGNUS_DB_PASSWORD, database: env.MAGNUS_DB_NAME || "mbilling", ca: env.MAGNUS_DB_CA || undefined } : undefined,
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
  if (cfg.magnusMode === "sql") {
    const { makeMysqlQuery, sqlSource } = await import("./magnus-sql.mjs");
    cfg.magnusSource = sqlSource(await makeMysqlQuery(cfg.magnusDb));
  }
  http.createServer(makeHandler(cfg)).listen(Number(process.env.PORT ?? 8787), process.env.BIND ?? "127.0.0.1", () =>
    console.log(`line-evidence adapter listening (read-only); cache ${cfg.cacheSeconds}s, ${cfg.rpm} rpm`));
}
