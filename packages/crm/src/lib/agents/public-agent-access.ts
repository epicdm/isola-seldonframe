export type AgentAccessStatus = "draft" | "test" | "live" | "paused" | string;

/** Only the published live agent is public. Test-mode access requires an
 * authenticated operator session already verified against the agent's org. */
export function canAccessAgentTurn(
  status: AgentAccessStatus,
  operatorTestSession: boolean,
): boolean {
  if (operatorTestSession) return status === "test" || status === "live";
  return status === "live";
}
