// bind — pure composition for binding/unbinding an MCP connector to an agent.
//
// WHY a separate pure module (not the "use server" actions file): the bind FLOW
// (resolve endpoint → store key encrypted → discover tools → cache + enable onto
// the blueprint) is the interesting logic, and it must be unit-testable with
// injected discover + secret-store (no DB, no network). A "use server" file can
// only export async functions, so the composer can't be a re-exported const
// there. Keeping it here lets bind.spec.ts drive it directly; the thin
// "use server" action (actions.ts) wires the real deps + the blueprint DB write.
//
// SECURITY: the apiKey is handed to deps.storeSecret (the AES-GCM
// workspaceSecrets store) and NEVER written to the blueprint — the blueprint
// only carries the `serviceName` pointer + the (non-secret) discovered tool
// schemas. Hardened 2026-10-21 (agent-connector-guard): a BYO endpoint must be
// https AND resolve only to public addresses before any discovery; the id and
// serviceName are derived HERE (never from input); the key is stored only
// AFTER discovery succeeds; a bind never replaces a binding of another kind;
// failures surface as fixed codes (AgentConnectorError), never upstream text.

import {
  getVettedConnector,
  type ConnectorBinding,
  type McpToolSchema,
} from "./connectors";
import type { DnsResolver } from "@/lib/security/ssrf-guard";
import {
  AgentConnectorError,
  agentByoServiceName,
  byoServiceName,
  validateAgentByoEndpoint,
} from "./agent-connector-guard";

/** What the caller is binding. For a vetted connector only the id is needed
 *  (endpoint comes from the registry); for BYO the operator supplies the HTTPS
 *  endpoint. `serviceName` is the encrypted-secret key. */
export type BindConnectorInput =
  | { kind: "vetted"; id: string; serviceName: string }
  | { kind: "byo"; id: string; serviceName: string; endpoint: string };

/** Injected side effects for the bind composer. Defaults (in actions.ts) wire
 *  the real encrypted-secret store + the inline MCP client's listTools. */
export type BindDeps = {
  /** Persist the bearer key ENCRYPTED for (workspace, serviceName). */
  storeSecret: (args: { workspaceId: string; serviceName: string; value: string }) => Promise<void>;
  /** Discover the server's tools (typically createMcpClient(endpoint, bearer).listTools()). */
  discoverTools: (args: { endpoint: string; bearer: string }) => Promise<McpToolSchema[]>;
  /** DNS resolver for the public-address check (tests inject; prod = dns.lookup). */
  resolve?: DnsResolver;
};

/**
 * Validate + discover + store, producing the ConnectorBinding to persist.
 * Pure of I/O except through `deps`.
 *
 * The caller's `connector` contributes only its kind and the vetted id / BYO
 * endpoint. Order: validate endpoint (public https) → derive id + serviceName →
 * refuse a cross-kind clash → discover tools → THEN store the key.
 * `secretScope.agentId` scopes a BYO secret to one workspace agent; without it
 * the workspace-wide byo_<slug> name is used (Studio templates).
 */
export async function buildConnectorBinding(args: {
  orgId: string;
  connector: BindConnectorInput;
  apiKey: string;
  /** Optional allowlist; default = enable every discovered tool. */
  enabledTools?: string[];
  deps: BindDeps;
  /** Current bindings — a bind may replace same-kind, never another kind. */
  existing?: ConnectorBinding[];
  secretScope?: { agentId: string };
}): Promise<ConnectorBinding> {
  const { orgId, connector, apiKey, deps } = args;

  let kind: "vetted" | "byo";
  let id: string;
  let serviceName: string;
  let endpoint: string;
  if (connector?.kind === "byo") {
    const v = await validateAgentByoEndpoint(connector.endpoint, { resolve: deps.resolve });
    kind = "byo";
    id = v.id;
    endpoint = v.endpoint;
    serviceName = args.secretScope ? agentByoServiceName(args.secretScope.agentId, v.endpoint) : byoServiceName(v.id);
  } else if (connector?.kind === "vetted") {
    const vetted = getVettedConnector(connector.id);
    if (!vetted) throw new AgentConnectorError("unknown_connector");
    kind = "vetted";
    id = vetted.id;
    serviceName = vetted.secretService;
    endpoint = vetted.endpoint;
  } else {
    throw new AgentConnectorError("unknown_connector");
  }

  const clash = (args.existing ?? []).find((b) => b.id === id);
  if (clash && clash.kind !== kind) throw new AgentConnectorError("connector_conflict");

  let tools: McpToolSchema[];
  try {
    tools = await deps.discoverTools({ endpoint, bearer: apiKey });
  } catch (err) {
    if (err instanceof AgentConnectorError) throw err;
    if (err instanceof Error && /\bredirect_refused\b/.test(err.message)) {
      throw new AgentConnectorError("redirect_refused");
    }
    throw new AgentConnectorError("discovery_failed");
  }

  try {
    await deps.storeSecret({ workspaceId: orgId, serviceName, value: apiKey });
  } catch {
    throw new AgentConnectorError("save_failed");
  }

  const enabledTools =
    args.enabledTools && args.enabledTools.length > 0
      ? args.enabledTools
      : tools.map((t) => t.name);

  const discoveredAt = new Date().toISOString();

  if (kind === "vetted") {
    return { id, kind: "vetted", serviceName, enabledTools, tools, discoveredAt };
  }
  return { id, kind: "byo", serviceName, endpoint, enabledTools, tools, discoveredAt };
}

/** Append `incoming` to `existing`, replacing any binding with the same id
 *  (re-bind / refresh). Pure. */
export function mergeConnectorBinding(
  existing: ConnectorBinding[] | undefined,
  incoming: ConnectorBinding,
): ConnectorBinding[] {
  const without = (existing ?? []).filter((b) => b.id !== incoming.id);
  return [...without, incoming];
}

/** Drop the binding with `id` (used by unbind). Pure. */
export function removeConnectorBinding(
  existing: ConnectorBinding[] | undefined,
  id: string,
): ConnectorBinding[] {
  return (existing ?? []).filter((b) => b.id !== id);
}

/** Re-enable a subset on an existing binding (used by refresh to preserve the
 *  operator's enabled choices while re-caching schemas). Pure. */
export function withRediscoveredTools(
  binding: ConnectorBinding,
  tools: McpToolSchema[],
  enabledTools?: string[],
): ConnectorBinding {
  const enabled =
    enabledTools && enabledTools.length > 0
      ? enabledTools
      : // Preserve still-valid previous choices; if none, enable all.
        binding.enabledTools.filter((n) => tools.some((t) => t.name === n));
  const nextEnabled = enabled.length > 0 ? enabled : tools.map((t) => t.name);
  return { ...binding, tools, enabledTools: nextEnabled, discoveredAt: new Date().toISOString() };
}
