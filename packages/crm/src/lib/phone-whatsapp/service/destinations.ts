// EPIC-managed calling, increment 2: WHERE calls are answered. The customer picks from a STAFF-MAINTAINED catalog; nothing is typed in by the customer.
//
// Two kinds of target, both ALREADY EXISTING things that answer a SIP call, so no new runtime is created:
//   - a PBX destination (queue, ring group or extension) that staff pre-created in the customer's PBX tenant (FusionPBX has no API for inbound routes, so
//     staff create it; the catalog only records that it exists and which workspace it belongs to);
//   - an existing compatible voice agent, referenced by id and reached through an existing endpoint (the PBX/PJSIP extension the agent already answers on).
//     The catalog entry points at the agent; it does not host, start or configure one.
export type DestinationKind = "pbx_queue" | "pbx_ring_group" | "pbx_extension" | "voice_agent";

export type DestinationOption = {
  id: string;
  label: string;
  kind: DestinationKind;
  /** pbx_*: trunk + dialled extension as the PBX knows them. voice_agent: the agent's id in the existing agent registry. */
  target: { trunk: string; ext: string } | { agentRef: string };
  /** The workspace this option belongs to, or "shared" for an EPIC-wide option staff have marked safe to offer (e.g. the EPIC front desk is NOT one). */
  workspaceId: string | "shared";
  status: "active" | "disabled";
};

/** Read-only view of the existing agent registry (Clawith/Uplink). Used only to confirm a referenced agent exists and belongs to the workspace. */
export interface AgentDirectory {
  exists(agentRef: string, workspaceId: string): Promise<boolean>;
}

export async function selectableDestinations(catalog: DestinationOption[], workspaceId: string, agents: AgentDirectory): Promise<DestinationOption[]> {
  const out: DestinationOption[] = [];
  for (const d of catalog) {
    if (d.status !== "active") continue;
    if (d.workspaceId !== workspaceId && d.workspaceId !== "shared") continue;
    if (d.kind === "voice_agent") {
      if (!("agentRef" in d.target) || !(await agents.exists(d.target.agentRef, workspaceId))) continue; // a dangling agent reference is never offered
    } else if (!("trunk" in d.target) || !d.target.trunk || !d.target.ext) {
      continue;
    }
    out.push(d);
  }
  return out;
}
