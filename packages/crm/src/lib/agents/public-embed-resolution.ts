export type PublicEmbedAgent = {
  orgSlug: string;
  slug: string;
  status: string;
};

export function resolveRequestedEmbedAgent<T extends PublicEmbedAgent>(
  rows: readonly T[],
  orgSlug: string,
  agentSlug: string,
): T | null {
  return rows.find((row) => row.orgSlug === orgSlug && row.slug === agentSlug) ?? null;
}

export function isEmbedAgentAccessible(status: string): boolean {
  return status === "live" || status === "test";
}

export function buildEmbedTurnUrl(origin: string, orgSlug: string, agentSlug: string): string {
  return `${origin}/api/v1/public/agent/${orgSlug}--${agentSlug}/turn`;
}
