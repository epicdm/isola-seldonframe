// Connector guard — the server-side rules every MCP connector write goes
// through (bind.ts buildConnectorBinding for the agent AND Studio template
// paths; store.ts updateAgentBlueprint for blueprint patches). Pure helpers,
// no DB; DNS is dependency-injectable for tests.
//
//   1. SSRF: a BYO endpoint must be https:// and resolve ONLY to public
//      addresses (reuses lib/security/ssrf-guard — loopback, RFC1918,
//      link-local/metadata, CGNAT, unique-local, IP-literal and mapped-IPv4
//      tricks). Discovery uses a fetch that never follows a redirect.
//   2. Connector id + secret serviceName are derived on the server (BYO: from
//      the validated endpoint; vetted: from the registry), never from input.
//   3. Workspace-agent BYO secrets are scoped per agent.
//   4. Errors leave as short fixed codes — never upstream text.
//   5. A blueprint patch may drop a connector or change its tool selection, but
//      may not add or repoint one (that would let it name any stored secret and
//      send it to any host); adding goes through the bind flow.
//
// Known limits (not closed here): the conversation-time MCP call does not
// re-validate the endpoint, and connect-IP pinning against DNS rebinding is
// ssrf-guard's tracked follow-up.

import { createHash } from "node:crypto";
import { assertPublicHttpUrl, type DnsResolver } from "@/lib/security/ssrf-guard";
import type { ConnectorBinding } from "./connectors";

/** Fixed, UI-safe error codes. Nothing else ever leaves the bind path. */
export type AgentConnectorErrorCode =
  | "endpoint_not_allowed"
  | "unknown_connector"
  | "connector_conflict"
  | "discovery_failed"
  | "redirect_refused"
  | "save_failed"
  | "connectors_patch_not_allowed";

export class AgentConnectorError extends Error {
  constructor(readonly code: AgentConnectorErrorCode) {
    super(code);
    this.name = "AgentConnectorError";
  }
}

/** Map anything thrown in the bind/refresh path to a fixed code. The MCP client
 *  re-wraps fetch errors in a plain Error, so a redirect refusal is recognised
 *  by its code appearing in the wrapped message. */
export function agentConnectorErrorCode(err: unknown): AgentConnectorErrorCode {
  if (err instanceof AgentConnectorError) return err.code;
  if (err instanceof Error && /\bredirect_refused\b/.test(err.message)) return "redirect_refused";
  return "discovery_failed";
}

/** Stable id from an endpoint (host + path slug) — same rule as the Studio editor. */
export function byoSlug(url: URL): string {
  const raw = `${url.host}${url.pathname}`.toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "custom-mcp";
}

/** Workspace-wide BYO secret name (Studio templates; unchanged naming). */
export function byoServiceName(slug: string): string {
  return `byo_${slug}`;
}

function agentTag(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 12);
}

/** Per-agent BYO secret name. Bounded to the same 52-char maximum as
 *  byo_<48-char slug>, because the runtime namespaces tool names as
 *  `${serviceName}__${tool}` and model tool names are length-limited. */
export function agentByoServiceName(agentId: string, slug: string): string {
  return `byo_a${agentTag(agentId)}_${slug.slice(0, 34)}`;
}

/** True only for a secret this agent's own BYO bind created. */
export function isAgentScopedSecret(agentId: string, serviceName: string): boolean {
  return serviceName.startsWith(`byo_a${agentTag(agentId)}_`);
}

/** Validate a BYO endpoint: https only, public addresses only. Returns the
 *  normalised endpoint and its derived id. Throws endpoint_not_allowed. */
export async function validateAgentByoEndpoint(
  raw: string,
  opts: { resolve?: DnsResolver } = {},
): Promise<{ endpoint: string; id: string }> {
  let parsed: URL;
  try {
    parsed = new URL(String(raw ?? "").trim());
  } catch {
    throw new AgentConnectorError("endpoint_not_allowed");
  }
  if (parsed.protocol !== "https:") throw new AgentConnectorError("endpoint_not_allowed");
  try {
    const { url } = await assertPublicHttpUrl(parsed.toString(), opts.resolve ? { resolve: opts.resolve } : {});
    return { endpoint: url.toString(), id: byoSlug(url) };
  } catch {
    throw new AgentConnectorError("endpoint_not_allowed");
  }
}

/** A fetch that never follows redirects: any 3xx (or opaque redirect) throws. */
export function noRedirectFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, { ...init, redirect: "manual" });
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      throw new AgentConnectorError("redirect_refused");
    }
    return res;
  }) as typeof fetch;
}

function identityOf(b: ConnectorBinding): string {
  const r = b as { kind: string; id: string; serviceName?: string; endpoint?: string };
  return JSON.stringify([r.kind, r.id, r.serviceName ?? null, r.endpoint ?? null]);
}

/**
 * A blueprint `connectors` patch from an untrusted caller (update_blueprint
 * API, dashboard save, improve loop) may only keep or drop existing bindings —
 * each incoming binding must match an existing one on kind, id, serviceName and
 * endpoint. Tool lists / enabledTools may change. Returns false otherwise.
 */
export function isConnectorsPatchAllowed(
  existing: ConnectorBinding[] | undefined,
  incoming: ConnectorBinding[] | undefined,
): boolean {
  if (incoming === undefined) return true;
  if (!Array.isArray(incoming)) return false;
  const known = new Set((existing ?? []).map(identityOf));
  return incoming.every((b) => b && typeof b === "object" && known.has(identityOf(b)));
}
