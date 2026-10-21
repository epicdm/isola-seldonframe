"use client";

// Connectors on a WORKSPACE agent (agents table) — the agent-scoped twin of the
// Studio template editor's Connectors card. Binds a Custom MCP endpoint + key via
// the existing bindMcpConnectorAction (lib/agents/mcp/actions.ts), which stores
// the key ENCRYPTED and caches the discovered tool schemas onto
// blueprint.connectors. The key lives in component state only until the action
// returns, is cleared regardless of outcome, and is never rendered or logged.
//
// The actions are injectable (defaulting to the real server actions) so the
// form → action wiring is unit-testable without a database.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plug, Plus, Trash2 } from "lucide-react";
import {
  bindMcpConnectorAction,
  unbindMcpConnectorAction,
} from "@/lib/agents/mcp/actions";
import type { ConnectorBinding } from "@/lib/agents/mcp/connectors";

type BindAction = typeof bindMcpConnectorAction;
type UnbindAction = typeof unbindMcpConnectorAction;

export const DEFAULT_AGENT_CONNECTOR_ACTIONS: { bind: BindAction; unbind: UnbindAction } = {
  bind: bindMcpConnectorAction,
  unbind: unbindMcpConnectorAction,
};

type Props = {
  agentId: string;
  initialConnectors: ConnectorBinding[];
  bindAction?: BindAction;
  unbindAction?: UnbindAction;
};

export function AgentConnectorsCard({
  agentId,
  initialConnectors,
  bindAction = DEFAULT_AGENT_CONNECTOR_ACTIONS.bind,
  unbindAction = DEFAULT_AGENT_CONNECTOR_ACTIONS.unbind,
}: Props) {
  const router = useRouter();
  const connectors = initialConnectors.filter((b) => b.kind !== "composio");

  const [adding, setAdding] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isBinding, startBind] = useTransition();
  const [bindError, setBindError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [isRemoving, startRemove] = useTransition();
  const [rowError, setRowError] = useState<string | null>(null);

  const endpointValid = (() => {
    const v = endpoint.trim();
    if (!v) return false;
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const canConnect = endpointValid && apiKey.trim().length > 0 && !isBinding;

  const connect = () => {
    setBindError(null);
    setConnected(null);
    const key = apiKey.trim();
    const url = endpoint.trim();
    startBind(async () => {
      try {
        // id + serviceName are re-derived (and scoped to this agent) on the
        // server; the values sent here are advisory only.
        const slug = slugForByo(url);
        const result = await bindAction({
          agentId,
          connector: { kind: "byo", id: slug, serviceName: `byo_${slug}`, endpoint: url },
          apiKey: key,
        });
        if (!result.ok) {
          setBindError(friendlyBindError(result.error));
          return;
        }
        setConnected(`Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`);
        setEndpoint("");
        setAdding(false);
        router.refresh();
      } catch {
        setBindError(friendlyBindError("unexpected"));
      } finally {
        // Never keep the key around, whatever the outcome.
        setApiKey("");
      }
    });
  };

  const remove = (connectorId: string) => {
    setRowError(null);
    startRemove(async () => {
      const result = await unbindAction({ agentId, connectorId });
      if (!result.ok) {
        setRowError("Couldn't remove the connector.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="agent-connectors-heading">
      <h2 id="agent-connectors-heading" className="text-card-title">
        Connectors
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Connectors give this agent external tools from an MCP server. Changes apply to the
        agent&apos;s next conversation.
      </p>

      {connectors.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No connectors yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {connectors.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
              <span className="truncate text-sm font-medium">
                {b.kind === "byo" ? `Custom: ${hostOf(b.endpoint)}` : b.id}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {(b.enabledTools ?? []).length}/{(b.tools ?? []).length} tools
                </span>
                <button
                  type="button"
                  onClick={() => remove(b.id)}
                  disabled={isRemoving}
                  aria-label={`Remove ${b.id}`}
                  className="crm-button-secondary inline-flex h-8 items-center px-2 text-xs"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {rowError && <p className="mt-2 text-xs text-rose-600">{rowError}</p>}
      {connected && <p className="mt-2 text-xs text-emerald-600">{connected}</p>}

      <div className="mt-4 border-t pt-4">
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setBindError(null);
            }}
            className="crm-button-secondary inline-flex h-9 items-center gap-1.5 px-3 text-sm"
          >
            <Plus className="size-4" />
            Add connector
          </button>
        ) : (
          <div className="space-y-3 rounded-lg border bg-background p-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">MCP endpoint (https://…)</span>
              <input
                type="url"
                inputMode="url"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                disabled={isBinding}
                placeholder="https://your-mcp-server.com/mcp"
                aria-invalid={endpoint.trim().length > 0 && !endpointValid}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-60"
              />
            </label>
            {endpoint.trim().length > 0 && !endpointValid && (
              <p className="text-xs text-rose-600">Enter a full https:// URL.</p>
            )}
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">API key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={isBinding}
                placeholder="Paste the connector's API key"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-60"
              />
            </label>
            <p className="text-[11px] text-muted-foreground">
              Stored encrypted. We never show it again after you connect.
            </p>
            {bindError && <p className="text-xs text-rose-600">{bindError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={connect}
                disabled={!canConnect}
                className="crm-button-primary inline-flex h-9 items-center gap-1.5 px-4 text-sm"
              >
                <Plug className={`size-4 ${isBinding ? "animate-pulse" : ""}`} />
                {isBinding ? "Connecting…" : "Connect"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setApiKey("");
                  setEndpoint("");
                  setBindError(null);
                }}
                disabled={isBinding}
                className="crm-button-secondary h-9 px-4 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Map a bind error CODE to fixed copy. Never echoes server or upstream text:
 *  an unknown value is reduced to a short safe code, else "error". */
const BIND_ERROR_COPY: Record<string, string> = {
  api_key_required: "Enter the connector's API key.",
  unauthorized: "You don't have access to this agent.",
  agent_not_found: "Agent not found.",
  endpoint_not_allowed: "That endpoint isn't allowed. Use a public https:// MCP address.",
  redirect_refused: "The MCP server redirected the request, which isn't allowed.",
  connector_conflict: "A different connector with this name is already on this agent.",
  unknown_connector: "Unknown connector.",
  discovery_failed: "Couldn't reach the MCP server or list its tools. Check the address and key.",
  save_failed: "Couldn't save the connector. Try again.",
};

export function friendlyBindError(error: string): string {
  const known = BIND_ERROR_COPY[error];
  if (known) return known;
  const code = /^[a-z_]{1,40}$/.test(error) ? error : "error";
  return `Couldn't connect (code: ${code}).`;
}

/** Stable id from a BYO endpoint (host + path slug) — same rule as the Studio editor. */
function slugForByo(endpoint: string): string {
  try {
    const u = new URL(endpoint.trim());
    const raw = `${u.host}${u.pathname}`.toLowerCase();
    const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    return slug || "custom-mcp";
  } catch {
    return "custom-mcp";
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
