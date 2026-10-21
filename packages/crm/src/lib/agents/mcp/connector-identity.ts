// Connector identity rules that must also run in client-shared modules (e.g.
// lib/marketplace/agent-listings.ts). Pure and synchronous — no node:* or DNS
// imports. The async, DNS-backed rules live in agent-connector-guard.ts.
//
// Identity = kind + id + secret pointer (serviceName) + endpoint. Whoever can
// write an identity decides which stored secret is sent where, so only the
// bind flow (agent-connector-guard / bind.ts) may mint a BYO identity.

import { getVettedConnector, type ConnectorBinding } from "./connectors";

type Loose = { kind?: unknown; id?: unknown; serviceName?: unknown; endpoint?: unknown };

export function connectorIdentity(b: ConnectorBinding): string {
  const r = (b ?? {}) as Loose;
  return JSON.stringify([r.kind ?? null, r.id ?? null, r.serviceName ?? null, r.endpoint ?? null]);
}

/** A vetted binding whose id is in the registry, whose secret pointer is the
 *  registry's own, and which carries no endpoint (the registry supplies it). */
export function isCanonicalVetted(b: ConnectorBinding): boolean {
  const r = (b ?? {}) as Loose;
  if (r.kind !== "vetted" || typeof r.id !== "string") return false;
  const v = getVettedConnector(r.id);
  return !!v && r.serviceName === v.secretService && r.endpoint === undefined;
}

/** A composio binding carries no endpoint and no secret pointer. */
export function isCleanComposio(b: ConnectorBinding): boolean {
  const r = (b ?? {}) as Loose;
  return r.kind === "composio" && r.serviceName === undefined && r.endpoint === undefined;
}

/**
 * Untrusted TEMPLATE blueprint patch (Studio save, interview loop, generators):
 * every incoming binding must either keep an existing identity unchanged, or be
 * a canonical vetted / clean composio binding. A new or repointed BYO binding
 * must go through the bind flow (which validates the endpoint and stores the
 * key) — never through a blueprint patch.
 */
export function isTemplateConnectorsPatchAllowed(
  existing: ConnectorBinding[] | undefined,
  incoming: ConnectorBinding[] | undefined,
): boolean {
  if (incoming === undefined) return true;
  if (!Array.isArray(incoming)) return false;
  const known = new Set((existing ?? []).map(connectorIdentity));
  return incoming.every(
    (b) =>
      !!b &&
      typeof b === "object" &&
      (known.has(connectorIdentity(b)) || isCanonicalVetted(b) || isCleanComposio(b)),
  );
}

/**
 * Connectors that may travel into ANOTHER tenant's template (marketplace
 * purchase / fork / install): canonical vetted and clean composio only. A
 * seller's BYO endpoint + secret pointer never transfers — the buyer binds
 * their own.
 */
export function crossTenantSafeConnectors(bindings: ConnectorBinding[] | undefined): ConnectorBinding[] {
  return (Array.isArray(bindings) ? bindings : []).filter((b) => isCanonicalVetted(b) || isCleanComposio(b));
}

/** How many of a cloned blueprint's connectors crossTenantSafeConnectors drops. */
export function crossTenantDroppedCount(blueprint: { connectors?: ConnectorBinding[] } | null | undefined): number {
  const all = Array.isArray(blueprint?.connectors) ? blueprint!.connectors! : [];
  return all.length - crossTenantSafeConnectors(all).length;
}

/**
 * Apply crossTenantSafeConnectors to a cloned blueprint (absent stays absent).
 * Fails closed but never silently: when anything is dropped the clone carries
 * `connectorsNotCopied` (a count — no endpoint or secret name), which the
 * Studio template page shows until the buyer reconnects.
 */
export function withCrossTenantSafeConnectors<T extends { connectors?: ConnectorBinding[] }>(
  blueprint: T,
): T & { connectorsNotCopied?: number } {
  if (blueprint == null) return blueprint;
  // Never inherit a count from the source: it describes THAT copy, not this one.
  const { connectorsNotCopied: _inherited, ...rest } = blueprint as T & { connectorsNotCopied?: unknown };
  void _inherited;
  const base = rest as T;
  if (base.connectors === undefined) return base;
  const kept = crossTenantSafeConnectors(base.connectors);
  const dropped = base.connectors.length - kept.length;
  return dropped > 0 ? { ...base, connectors: kept, connectorsNotCopied: dropped } : { ...base, connectors: kept };
}
