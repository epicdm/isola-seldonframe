// packages/crm/src/lib/marketplace/fulfillment.ts
// Marketplace purchase fulfilment (enable a block, finalize block/soul purchases,
// provision a bought agent). Moved out of lib/marketplace/actions.ts ("use server"):
// as exported server actions anyone could call them with any orgId and grant a
// paid block, soul or agent to any workspace without paying (Port
// def-uplink-server-actions-caller-supplied-orgid-onboarding-and-portal-admin-2026-10-21).
// They are plain server functions now, called by the Stripe webhooks and by the
// session-scoped actions in actions.ts. Code moved verbatim.

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { blockPurchases, marketplaceBlocks, marketplaceListings, organizations } from "@/db/schema";
import { installSoulPackage } from "@/lib/marketplace/install-soul";
import type { SoulPackage } from "@/lib/marketplace/soul-package";
import { buildInstalledAgentTemplate, type AgentListingForBuyer } from "@/lib/marketplace/agent-listings";
import { agentTemplates } from "@/db/schema/agent-templates";
import { resolveUniqueTemplateSlug } from "@/lib/agent-templates/store";
import type { AgentBlueprint } from "@/db/schema/agents";
import { resolveOrCreateBuyerDeployment, buildDefaultResolveBuyerDeploymentDeps, type BuyerListing } from "@/lib/marketplace/buyer/buyer-deployment";
import { buyerSetupPath } from "@/lib/marketplace/buyer/buyer-routes";
import { hasDeclaredTemplateVariables } from "@/lib/agent-templates/generalize";

export function readInstalledListingIds(settings: Record<string, unknown> | null | undefined) {
  const value = settings?.marketplaceInstalledListingIds;
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value.map((item) => String(item)).filter(Boolean);
}

export async function hasOrgInstalledListing(orgId: string, listingId: string) {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const installedIds = readInstalledListingIds(org?.settings as Record<string, unknown> | null | undefined);
  return installedIds.includes(listingId);
}

export async function markOrgInstalledListing(orgId: string, listingId: string) {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const currentSettings = (org?.settings ?? {}) as Record<string, unknown>;
  const installedIds = readInstalledListingIds(currentSettings);

  if (installedIds.includes(listingId)) {
    return;
  }

  await db
    .update(organizations)
    .set({
      settings: {
        ...currentSettings,
        marketplaceInstalledListingIds: [...installedIds, listingId],
      },
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));
}

export async function finalizeBlockPurchaseFromWebhook(params: {
  orgId: string;
  userId?: string | null;
  blockId: string;
  stripePaymentId?: string | null;
}) {
  const [block] = await db
    .select({ blockId: marketplaceBlocks.blockId })
    .from(marketplaceBlocks)
    .where(and(eq(marketplaceBlocks.blockId, params.blockId), eq(marketplaceBlocks.generationStatus, "published")))
    .limit(1);

  if (!block) {
    return;
  }

  if (params.stripePaymentId) {
    const [existing] = await db
      .select({ id: blockPurchases.id })
      .from(blockPurchases)
      .where(
        and(
          eq(blockPurchases.orgId, params.orgId),
          eq(blockPurchases.blockId, params.blockId),
          eq(blockPurchases.stripePaymentId, params.stripePaymentId)
        )
      )
      .limit(1);

    if (existing) {
      await enableBlockForOrg(params.orgId, params.blockId);
      return;
    }
  }

  const [existingForOrg] = await db
    .select({ id: blockPurchases.id })
    .from(blockPurchases)
    .where(
      and(
        eq(blockPurchases.orgId, params.orgId),
        eq(blockPurchases.blockId, params.blockId),
        params.stripePaymentId ? eq(blockPurchases.stripePaymentId, params.stripePaymentId) : isNull(blockPurchases.stripePaymentId)
      )
    )
    .limit(1);

  if (!existingForOrg) {
    await db.insert(blockPurchases).values({
      orgId: params.orgId,
      userId: params.userId ?? null,
      blockId: params.blockId,
      stripePaymentId: params.stripePaymentId ?? null,
    });

    await db
      .update(marketplaceBlocks)
      .set({ installCount: sql`${marketplaceBlocks.installCount} + 1`, updatedAt: new Date() })
      .where(eq(marketplaceBlocks.blockId, params.blockId));
  }

  await enableBlockForOrg(params.orgId, params.blockId);
}

/** The columns both the soul and agent finalize/install paths read off a
 *  marketplace_listings row. `kind` discriminates which clone runs. */
export const LISTING_INSTALL_COLUMNS = {
  id: marketplaceListings.id,
  slug: marketplaceListings.slug,
  name: marketplaceListings.name,
  kind: marketplaceListings.kind,
  soulPackage: marketplaceListings.soulPackage,
  agentType: marketplaceListings.agentType,
  agentBlueprint: marketplaceListings.agentBlueprint,
} as const;

export type ListingInstallRow = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  soulPackage: unknown;
  agentType: string | null;
  agentBlueprint: AgentBlueprint | null;
};

/**
 * Clone a kind:'agent' listing into the buyer's org as a fresh DRAFT
 * agent_templates row (the buyer runs it on their OWN BYOK — nothing here
 * touches keys). Reuses the pure mapper (buildInstalledAgentTemplate) + the
 * agent-templates slug primitive (resolveUniqueTemplateSlug), and inserts via
 * the same agentTemplates table createAgentTemplate uses. Returns the new
 * template id.
 */
export async function cloneAgentListingIntoOrg(listing: ListingInstallRow, buyerOrgId: string): Promise<string> {
  const args = buildInstalledAgentTemplate(
    {
      id: listing.id,
      slug: listing.slug,
      name: listing.name,
      kind: listing.kind,
      agentType: listing.agentType,
      agentBlueprint: listing.agentBlueprint,
    } satisfies AgentListingForBuyer,
    buyerOrgId,
  );

  // Stamp the source listing id into the cloned blueprint (jsonb, no migration —
  // mirrors the agency-deploy `sourceTemplateId` stamp). The buyer→deployment
  // seam keys its idempotency on this so a re-purchase reuses the buyer's
  // existing template/deployment instead of cloning a second copy.
  const blueprint = { ...(args.blueprint ?? {}), sourceListingId: listing.id };

  const existing = await db
    .select({ slug: agentTemplates.slug })
    .from(agentTemplates)
    .where(eq(agentTemplates.builderOrgId, buyerOrgId));
  const slug = resolveUniqueTemplateSlug(args.name, existing.map((r) => r.slug));

  const [created] = await db
    .insert(agentTemplates)
    .values({ ...args, blueprint, slug })
    .returning({ id: agentTemplates.id });

  if (!created) {
    throw new Error("agent_templates insert returned no row");
  }
  return created.id;
}

/**
 * Clone a kind:'agent' listing into the buyer org AND resolve the buyer-owned
 * deployment of it (status 'draft') so the agent is RUNNABLE (the buyer's setup
 * wizard configures it: phone, calendar, go-live). Idempotent at the deployment
 * layer (one deployment per buyer+listing). Additive — NO money: this only
 * writes a template + a draft deployment row; the charge already happened
 * upstream (free → no charge; paid → Stripe). Returns the new template id + the
 * deployment id (the buyer-setup redirect target). The deployment step is
 * soft-fail: if it throws, the buyer still gets their cloned template (today's
 * behavior) and `deploymentId` is null — the install never fails on it.
 */
export async function provisionBuyerAgentFromListing(
  listing: ListingInstallRow,
  buyerOrgId: string,
): Promise<{ templateId: string; deploymentId: string | null }> {
  const templateId = await cloneAgentListingIntoOrg(listing, buyerOrgId);

  // 2026-07-16 (marketplace generalize, review fix) — a template with
  // DECLARED templateVariables (Task 1) must NEVER auto-deploy through this
  // direct shortcut: resolveOrCreateBuyerDeployment writes a `deployments`
  // row with no templateVarValues, and resolveDeploymentPersona would then
  // silently DROP every declared token (fillPlaceholders' drop-unknown-token
  // behavior) — a dishonest output on the buyer's very first run. There is no
  // fill form on this buyer-onboarding path (only the operator-side
  // studio/agents/[id]/deploy wizard has one). Rather than build a second
  // form here, this mirrors the EXISTING soft-fail contract just below
  // (deployment step failure -> deploymentId:null, buyer keeps the cloned
  // template): the buyer still gets their installed template + the purchase
  // still succeeds (money-safe — never break a completed purchase), but they
  // land in Studio instead of the setup wizard, where the template's own
  // "Deploy" wizard (which DOES gate + fill templateVariables) is the
  // downstream path that catches it.
  if (hasDeclaredTemplateVariables(listing.agentBlueprint as AgentBlueprint | null)) {
    return { templateId, deploymentId: null };
  }

  try {
    const buyerListing: BuyerListing = {
      id: listing.id,
      slug: listing.slug,
      name: listing.name,
      kind: listing.kind,
      agentType: listing.agentType,
      agentBlueprint: listing.agentBlueprint,
    };
    const result = await resolveOrCreateBuyerDeployment(
      { buyerOrgId, listing: buyerListing, agentTemplateId: templateId },
      buildDefaultResolveBuyerDeploymentDeps(),
    );
    return { templateId, deploymentId: result.ok ? result.deployment.id : null };
  } catch {
    // Soft-fail: a deployment hiccup must never break the buyer's purchase. They
    // keep their cloned template; the wizard redirect just falls back to Studio.
    return { templateId, deploymentId: null };
  }
}

export async function finalizeSoulPurchaseFromWebhook(params: {
  orgId: string;
  userId?: string | null;
  listingId?: string | null;
  listingSlug?: string | null;
  stripePaymentId?: string | null;
}) {
  if (!params.orgId) {
    return;
  }

  const listing = (params.listingId
    ? (
        await db
          .select(LISTING_INSTALL_COLUMNS)
          .from(marketplaceListings)
          .where(and(eq(marketplaceListings.id, params.listingId), eq(marketplaceListings.isPublished, true)))
          .limit(1)
      )[0]
    : params.listingSlug
      ? (
          await db
            .select(LISTING_INSTALL_COLUMNS)
            .from(marketplaceListings)
            .where(and(eq(marketplaceListings.slug, params.listingSlug), eq(marketplaceListings.isPublished, true)))
            .limit(1)
        )[0]
      : null) as ListingInstallRow | undefined;

  if (!listing) {
    return;
  }

  const alreadyInstalled = await hasOrgInstalledListing(params.orgId, listing.id);
  if (alreadyInstalled) {
    return;
  }

  // kind:'agent' → clone the blueprint into the buyer org AND provision the
  // buyer-owned deployment (so the bought agent is runnable + the setup wizard
  // has a target). Same Stripe charge + fee already fired at the checkout site
  // (purchaseAgentListing path), exactly like a paid soul — this step adds NO
  // money. kind:'soul' (default) → the original soul install, untouched.
  if (listing.kind === "agent") {
    await provisionBuyerAgentFromListing(listing, params.orgId);
  } else {
    await installSoulPackage(params.orgId, listing.soulPackage as SoulPackage);
  }
  await markOrgInstalledListing(params.orgId, listing.id);

  await db
    .update(marketplaceListings)
    .set({ installCount: sql`${marketplaceListings.installCount} + 1`, updatedAt: new Date() })
    .where(eq(marketplaceListings.id, listing.id));

  revalidatePath("/soul-marketplace");
  revalidatePath(`/soul-marketplace/${listing.slug}`);
  revalidatePath("/marketplace");
  revalidatePath(`/marketplace/${listing.slug}`);
}

/**
 * Provision the buyer-owned agent deployment when a #139 marketplace_purchases
 * row flips to `active` (the webhook `onActivated` hook). Looks up the listing by
 * the row's `listingId`; for a kind:'agent' listing, clones the blueprint into
 * the buyer org + resolves the buyer deployment (idempotent — one per
 * buyer+listing). Returns the buyer-setup target so the buyer's "Subscribed"
 * surface can deep-link into onboarding.
 *
 * Money-safe: this runs AFTER settlement and moves NO money — it only writes a
 * template + a draft deployment. Idempotent + best-effort (the webhook swallows
 * its errors). A non-agent (soul) listing is a no-op here (soul install is the
 * legacy webhook's job, untouched).
 */
export async function provisionBuyerAgentFromPurchaseRow(row: {
  buyerOrgId: string;
  listingId: string;
}): Promise<{ deploymentId: string | null; setupUrl: string | null }> {
  if (!row.buyerOrgId || !row.listingId) {
    return { deploymentId: null, setupUrl: null };
  }

  const [listing] = (await db
    .select(LISTING_INSTALL_COLUMNS)
    .from(marketplaceListings)
    .where(eq(marketplaceListings.id, row.listingId))
    .limit(1)) as ListingInstallRow[];

  // Only agent listings get a deployment; a soul purchase is handled elsewhere.
  if (!listing || listing.kind !== "agent") {
    return { deploymentId: null, setupUrl: null };
  }

  const { deploymentId } = await provisionBuyerAgentFromListing(listing, row.buyerOrgId);
  // Keep the org's installed-listing marker in sync (idempotent) so the buyer's
  // storefront state matches the legacy free/soul path.
  await markOrgInstalledListing(row.buyerOrgId, listing.id);
  return { deploymentId, setupUrl: buyerSetupPath(deploymentId) };
}

export async function enableBlockForOrg(orgId: string, blockId: string) {
  const [org] = await db
    .select({ id: organizations.id, enabledBlocks: organizations.enabledBlocks })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    return;
  }

  const current = Array.isArray(org.enabledBlocks) ? org.enabledBlocks : [];
  if (current.includes(blockId)) {
    return;
  }

  await db
    .update(organizations)
    .set({ enabledBlocks: [...current, blockId], updatedAt: new Date() })
    .where(eq(organizations.id, org.id));
}
