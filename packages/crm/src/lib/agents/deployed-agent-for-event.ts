// EPIC 2026-10-21 (staff-access correction): server-INTERNAL helpers moved verbatim out of the "use server" module next
// to this file, so they are no longer exported as client-callable server actions. Each takes its workspace as an
// argument and reads no session; only server code (webhooks, callbacks, event listeners, other server modules) calls them.

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { getOrgId } from "@/lib/auth/helpers";
import { getArchetype } from "@/lib/agents/archetypes";
import { assertWritable } from "@/lib/demo/server";
import { requireWorkspaceAdmin } from "@/lib/auth/require-workspace-role";
import type { AgentConfig } from "./configure-actions";

/**
 * 2026-05-18 — dispatch-time guard helper.
 *
 * Called by the outbound message dispatcher to ask "is there a
 * currently-deployed agent that owns this event?" If yes, the
 * dispatcher skips the basic intake-auto-reply trigger so the
 * customer doesn't get two SMS / two emails for the same event.
 *
 * Why this matters more than the auto-disable in
 * setAgentDeployStateAction: agents that were deployed BEFORE the
 * auto-disable code shipped never had their conflicting triggers
 * disabled. This runtime check covers them too. The auto-disable is
 * still useful as a UX nicety (so the operator sees the trigger
 * actually disabled in /emails after deploying), but it's no longer
 * load-bearing.
 *
 * Returns the archetype id of the first deployed agent owning the
 * event, or null if none. We don't need the full config — the caller
 * just needs to know "skip or fire".
 */
export async function findDeployedAgentForEvent(
  orgId: string,
  eventType: string,
): Promise<string | null> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;

  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const configs =
    settings.agentConfigs && typeof settings.agentConfigs === "object"
      ? (settings.agentConfigs as Record<string, AgentConfig>)
      : {};

  if (Object.keys(configs).length === 0) return null;

  const { listArchetypes } = await import("@/lib/agents/archetypes");
  const { getTriggerEventType } = await import("@/lib/agents/synthesis");

  for (const archetype of listArchetypes()) {
    const archetypeEvent = (() => {
      try {
        return getTriggerEventType(archetype.specTemplate) ?? null;
      } catch {
        return null;
      }
    })();
    if (archetypeEvent !== eventType) continue;
    const cfg = configs[archetype.id];
    if (!cfg) continue;
    // Deployed-and-not-paused = currently active.
    if (cfg.deployedAt && !cfg.pausedAt) return archetype.id;
  }
  return null;
}
