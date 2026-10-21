// Agent-scoped connector bind guard — the server-side rules the workspace
// agent's Connectors card relies on (lib/agents/mcp/actions.ts). Pure of I/O
// except through injected deps, so every rule is unit-testable.
//
//   1. SSRF: a BYO endpoint must be https:// and resolve ONLY to public
//      addresses (reuses lib/security/ssrf-guard — loopback, RFC1918,
//      link-local/metadata, CGNAT, unique-local, IP-literal and mapped-IPv4
//      tricks). Discovery never follows a redirect.
//   2. The connector id + secret serviceName are DERIVED HERE from the
//      validated endpoint (BYO) or the vetted registry — never taken from the
//      client — and the key is stored only AFTER discovery succeeds.
//      A bind can never replace a binding of a different kind (e.g. composio).
//   3. BYO secrets are scoped per agent (byo_agent_<agentId>_<slug>) so two
//      agents on the same endpoint never overwrite or delete each other's key.
//   4. Errors leave this module as short fixed codes — never upstream text.
//
// Known limit (unchanged here): the conversation-time MCP call (lib/agents/
// tools.ts) does not re-run the SSRF check, and connect-IP pinning against DNS
// rebinding is the ssrf-guard's tracked follow-up.

import { assertPublicHttpUrl, type DnsResolver } from "@/lib/security/ssrf-guard";
import { buildConnectorBinding, type BindConnectorInput, type BindDeps } from "./bind";
import { getVettedConnector, type ConnectorBinding } from "./connectors";

export const AGENT_BYO_SECRET_PREFIX = "byo_agent_";

/** Fixed, UI-safe error codes. Nothing else ever leaves the bind path. */
export type AgentConnectorErrorCode =
  | "endpoint_not_allowed"
  | "unknown_connector"
  | "connector_conflict"
  | "discovery_failed"
  | "redirect_refused"
  | "save_failed";

export class AgentConnectorError extends Error {
  constructor(readonly code: AgentConnectorErrorCode) {
    super(code);
    this.name = "AgentConnectorError";
  }
}

/** Map anything thrown in the bind/refresh path to a fixed code. */
export function agentConnectorErrorCode(err: unknown): AgentConnectorErrorCode {
  return err instanceof AgentConnectorError ? err.code : "discovery_failed";
}

/** Stable id from an endpoint (host + path slug) — same rule as the Studio editor. */
export function byoSlug(url: URL): string {
  const raw = `${url.host}${url.pathname}`.toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "custom-mcp";
}

export function agentByoServiceName(agentId: string, slug: string): string {
  return `${AGENT_BYO_SECRET_PREFIX}${agentId}_${slug}`;
}

/** True only for a secret this agent's own BYO bind created. */
export function isAgentScopedSecret(agentId: string, serviceName: string): boolean {
  return serviceName.startsWith(`${AGENT_BYO_SECRET_PREFIX}${agentId}_`);
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

/**
 * Build the binding to persist for a workspace agent. The client's connector
 * input is used only for its kind + vetted id / BYO endpoint; id and
 * serviceName are derived here. The key is written only after discovery.
 */
export async function prepareAgentConnectorBinding(args: {
  orgId: string;
  agentId: string;
  connector: BindConnectorInput;
  apiKey: string;
  existing: ConnectorBinding[] | undefined;
  enabledTools?: string[];
  deps: BindDeps & { resolve?: DnsResolver };
}): Promise<ConnectorBinding> {
  const { orgId, agentId, connector, apiKey, deps } = args;

  let serverInput: BindConnectorInput;
  if (connector.kind === "byo") {
    const v = await validateAgentByoEndpoint(connector.endpoint, { resolve: deps.resolve });
    serverInput = {
      kind: "byo",
      id: v.id,
      serviceName: agentByoServiceName(agentId, v.id),
      endpoint: v.endpoint,
    };
  } else if (connector.kind === "vetted") {
    const vetted = getVettedConnector(connector.id);
    if (!vetted) throw new AgentConnectorError("unknown_connector");
    serverInput = { kind: "vetted", id: vetted.id, serviceName: vetted.secretService };
  } else {
    throw new AgentConnectorError("unknown_connector");
  }

  const clash = (args.existing ?? []).find((b) => b.id === serverInput.id);
  if (clash && clash.kind !== serverInput.kind) throw new AgentConnectorError("connector_conflict");

  // Defer the secret write until discovery has succeeded.
  let pending: { workspaceId: string; serviceName: string; value: string } | null = null;
  let binding: ConnectorBinding;
  try {
    binding = await buildConnectorBinding({
      orgId,
      connector: serverInput,
      apiKey,
      enabledTools: args.enabledTools,
      deps: {
        storeSecret: async (a) => {
          pending = a;
        },
        discoverTools: deps.discoverTools,
      },
    });
  } catch (err) {
    if (err instanceof AgentConnectorError) throw err;
    throw new AgentConnectorError("discovery_failed");
  }
  if (pending) {
    try {
      await deps.storeSecret(pending);
    } catch {
      throw new AgentConnectorError("save_failed");
    }
  }
  return binding;
}
