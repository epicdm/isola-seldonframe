// EPIC 2026-10-21 (staff-access correction): resolvePublishGuard moved verbatim out of the "use server" seller-actions
// module. It takes its dependencies (including getOrgId) as an ARGUMENT; as an exported server action a client could
// have supplied them. Only server code calls it now.

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { marketplaceListings } from "@/db/schema/marketplace";
import { agentTemplates } from "@/db/schema/agent-templates";
import { stripeConnections } from "@/db/schema/payments";
import { getCurrentUser, getOrgId } from "@/lib/auth/helpers";
import { assertWritable } from "@/lib/demo/server";
import {
  TEMPLATE_LINK_TAG_PREFIX,
  buildListingTags,
  splitListingTags,
} from "@/lib/marketplace/listing-tags";
import {
  validateListingPricing,
  normalizePricingForPersist,
  resolveListingPublishState,
  isPriceModel,
  isOutcomeType,
  type PriceModel,
  type OutcomeType,
} from "@/lib/marketplace/pricing-model";
import { getLatestEvalRun, listEvalRunsForSubject } from "@/lib/agents/evals/eval-runs-store";
import { buildTrustStats } from "@/lib/marketplace/trust-stats";
import { applyTastePreferencesUpdate } from "@/lib/marketplace/taste/apply-taste-preferences";
import { isAgentLifecycleEnabled } from "@/lib/agents/lifecycle/policy";
import {
  lifecycleGate,
  resolvePublishGate,
  hasActionableTools,
  type LifecycleGateDeps,
} from "@/lib/agents/lifecycle/gate";
import { supervisedRuns } from "@/db/schema/agent-lifecycle";
import type { AgentTemplate } from "@/db/schema/agent-templates";
import { requireWorkspaceAdmin } from "@/lib/auth/require-workspace-role";
import { getOrgIdAsWorkspaceAdmin } from "@/lib/auth/require-workspace-role";

/** Injectable seam for `resolvePublishGuard` — DI so the wiring below (F4,
 *  Wave 1 review) is directly unit-testable without a live DB/session.
 *  Production wires the real getOrgId/getCurrentUser/db lookups
 *  unchanged; this is a pure extraction of publishOrUpdateAgentListingAction's
 *  existing preamble, not a behavior change. */
export type ResolvePublishGuardDeps = {
  getOrgId: () => Promise<string | null | undefined>;
  getCurrentUser: () => Promise<{ id: string } | null | undefined>;
  loadTemplate: (args: { templateId: string; orgId: string }) => Promise<AgentTemplate | null>;
  lifecycleGateDeps: LifecycleGateDeps;
  isLifecycleEnabled: boolean;
};

export type PublishGuardResult =
  | { ok: true; orgId: string; template: AgentTemplate }
  | { ok: false; error: "unauthorized" | "invalid" | "template_not_found" }
  | { ok: false; error: "lifecycle_gate"; missing: string[] };

/**
 * Auth + org-guard + agent-lifecycle publish gate — the preamble
 * `publishOrUpdateAgentListingAction` runs BEFORE any listing write. Extracted
 * as its own DI'd function (F4, Wave 1 review) so the gate wiring is directly
 * testable: flag on + gate missing → `{ok:false, error:"lifecycle_gate"}`
 * (checked before the template's org-guard even completes any write — there
 * is no write path in this function at all); flag on + gate satisfied →
 * `{ok:true, ...}`; flag off → `{ok:true, ...}` regardless of the gate.
 */
export async function resolvePublishGuard(
  deps: ResolvePublishGuardDeps,
  input: { templateId: string },
): Promise<PublishGuardResult> {
  const orgId = await deps.getOrgId();
  const user = await deps.getCurrentUser();
  if (!user?.id || !orgId) return { ok: false, error: "unauthorized" };

  const templateId = String(input.templateId ?? "").trim();
  if (!templateId) return { ok: false, error: "invalid" };

  const template = await deps.loadTemplate({ templateId, orgId });
  if (!template) return { ok: false, error: "template_not_found" };

  if (deps.isLifecycleEnabled) {
    const gate = await lifecycleGate(deps.lifecycleGateDeps, {
      orgId,
      templateId,
      // F-D: a tool-free template (pure-chat FAQ agent) can never pass a
      // supervised run — exempt it here too, so the server-side publish
      // gate matches the Run stage's ladder badge exactly.
      hasActionableTools: hasActionableTools({
        connectors: template.blueprint?.connectors,
        capabilities: template.blueprint?.capabilities,
      }),
    });
    const publishGate = resolvePublishGate({ enabled: true, missing: gate.missing });
    if (publishGate.blocked) {
      return { ok: false, error: "lifecycle_gate", missing: gate.missing };
    }
  }

  return { ok: true, orgId, template };
}
