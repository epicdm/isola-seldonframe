"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { apiKeys, landingPages, organizations } from "@/db/schema";
import { getOrgId, requireAuth } from "@/lib/auth/helpers";
import { isAdminTokenUserId } from "@/lib/auth/admin-token";
import { mintWorkspaceToken } from "@/lib/auth/workspace-token";
import { assertWritable } from "@/lib/demo/server";
import { COMMON_TIMEZONES, type TimezoneOption } from "@/lib/workspace/timezones";
import {
  mutateWorkspaceName,
  replaceWorkspaceNameInHtml,
} from "@/lib/blueprint/mutate";
import type { Blueprint } from "@/lib/blueprint/types";

interface UpdateResult {
  ok: boolean;
  error?: string;
}

/**
 * P0-4: update workspace name + timezone. Both fields live on the
 * `organizations` row (not the soul JSONB) — they're operational
 * settings rather than content-generation context.
 *
 * Permitted for both NextAuth sessions (must be the org owner) and
 * admin-token sessions (always treated as admin for their workspace).
 */
export async function updateWorkspaceSettingsAction(
  formData: FormData
): Promise<UpdateResult> {
  assertWritable();
  await requireAuth();
  const orgId = await getOrgId();
  if (!orgId) {
    return { ok: false, error: "Workspace not found." };
  }

  const name = String(formData.get("name") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();

  if (!name) {
    return { ok: false, error: "Workspace name is required." };
  }
  if (name.length > 80) {
    return { ok: false, error: "Workspace name must be 80 characters or fewer." };
  }
  // Validate timezone against the curated list — guards against form
  // tampering and obvious typos. Operators on rare zones can pick the
  // closest umbrella region.
  if (!timezone || !COMMON_TIMEZONES.includes(timezone as TimezoneOption)) {
    return { ok: false, error: "Pick a valid timezone." };
  }

  const updated = await db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ name: organizations.name, soul: organizations.soul })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");

    if (!workspace) return false;

    // The public page <title>/og/twitter and JSON-LD read the business name from organizations.soul, not from the landing row
    // (found by Lane A in v4.43 acceptance). Only the two exact name keys are touched, and only when they held the old name.
    const renamed = workspace.name !== name;
    const currentSoul = (workspace.soul ?? null) as Record<string, unknown> | null;
    const soulHoldsOldName =
      renamed &&
      currentSoul !== null &&
      typeof currentSoul === "object" &&
      (currentSoul.business_name === workspace.name || currentSoul.businessName === workspace.name);
    const nextSoul = soulHoldsOldName
      ? {
          ...currentSoul,
          ...(currentSoul.business_name === workspace.name ? { business_name: name } : {}),
          ...(currentSoul.businessName === workspace.name ? { businessName: name } : {}),
        }
      : null;

    await tx
      .update(organizations)
      .set({ name, timezone, updatedAt: new Date(), ...(nextSoul ? { soul: nextSoul as typeof organizations.$inferInsert.soul } : {}) })
      .where(eq(organizations.id, orgId));

    if (workspace.name === name) return true;

    const pages = await tx
      .select({
        id: landingPages.id,
        title: landingPages.title,
        seo: landingPages.seo,
        blueprintJson: landingPages.blueprintJson,
        contentHtml: landingPages.contentHtml,
      })
      .from(landingPages)
      .where(eq(landingPages.orgId, orgId));

    for (const page of pages) {
      let blueprintJson = page.blueprintJson;
      let blueprintChanged = false;

      if (
        isWorkspaceBlueprint(blueprintJson) &&
        blueprintJson.workspace.name === workspace.name
      ) {
        const nextBlueprint = mutateWorkspaceName(
          blueprintJson,
          name,
          workspace.name
        );
        blueprintJson = JSON.parse(JSON.stringify(nextBlueprint)) as Record<string, unknown>;
        blueprintChanged = true;
      }

      const htmlUpdate = replaceWorkspaceNameInHtml(
        page.contentHtml,
        workspace.name,
        name
      );
      // The page <title>, og:title and twitter:title come from landing_pages.title / seo, not from the blueprint or the HTML
      // (found by Lane A in v4.43 acceptance: after a rename the served metadata still carried the old name).
      const nextTitle = typeof page.title === "string" ? page.title.split(workspace.name).join(name) : page.title;
      const titleChanged = nextTitle !== page.title;
      const nextSeo = replaceNameInJsonStrings(page.seo, workspace.name, name);
      const seoChanged = JSON.stringify(nextSeo) !== JSON.stringify(page.seo);
      if (!blueprintChanged && htmlUpdate.replacements === 0 && !titleChanged && !seoChanged) continue;

      await tx
        .update(landingPages)
        .set({
          ...(blueprintChanged ? { blueprintJson } : {}),
          ...(htmlUpdate.replacements > 0
            ? { contentHtml: htmlUpdate.contentHtml }
            : {}),
          ...(titleChanged ? { title: nextTitle } : {}),
          ...(seoChanged ? { seo: nextSeo as Record<string, unknown> } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(landingPages.id, page.id), eq(landingPages.orgId, orgId)));
    }

    return true;
  });

  if (!updated) return { ok: false, error: "Workspace not found." };

  revalidatePath("/settings/workspace");
  revalidatePath("/dashboard");
  return { ok: true };
}

/** Replace the literal old name inside every string value of a JSON document (objects and arrays), leaving the shape alone. */
function replaceNameInJsonStrings(value: unknown, oldName: string, newName: string): unknown {
  if (!oldName || oldName === newName) return value;
  if (typeof value === "string") return value.split(oldName).join(newName);
  if (Array.isArray(value)) return value.map((item) => replaceNameInJsonStrings(item, oldName, newName));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceNameInJsonStrings(item, oldName, newName)]),
    );
  }
  return value;
}

function isWorkspaceBlueprint(value: unknown): value is Blueprint {
  if (value == null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const workspace = candidate.workspace;
  const intake = candidate.intake;
  const booking = candidate.booking;
  if (workspace == null || typeof workspace !== "object") return false;
  if (intake == null || typeof intake !== "object") return false;
  if (booking == null || typeof booking !== "object") return false;
  const workspaceName = (workspace as Record<string, unknown>).name;
  const completion = (intake as Record<string, unknown>).completion;
  const eventType = (booking as Record<string, unknown>).eventType;
  const completionMessage =
    completion != null && typeof completion === "object"
      ? (completion as Record<string, unknown>).message
      : undefined;
  return (
    typeof workspaceName === "string" &&
    completion != null &&
    typeof completion === "object" &&
    (completionMessage === undefined || typeof completionMessage === "string") &&
    eventType != null &&
    typeof eventType === "object" &&
    typeof (eventType as Record<string, unknown>).title === "string"
  );
}

// ─── API key (workspace bearer token) management ──────────────────────

export interface MintedApiKey {
  ok: true;
  /** Raw token value, returned ONCE — the DB only stores its hash. */
  token: string;
  prefix: string;
  tokenId: string;
  name: string;
  expiresAt: string | null;
}

interface MintFailure {
  ok: false;
  error: string;
}

/**
 * Mints a long-lived workspace bearer token (no expiry) the operator
 * can use as `SELDONFRAME_API_KEY` (set in their MCP env or pass via
 * `Authorization: Bearer wst_…` to v1 API routes).
 *
 * Distinct from the 7-day admin-token cookie minted by create_workspace —
 * this token is meant for permanent, programmatic access from a dev
 * machine. The "name" is operator-supplied so they can label keys
 * ("CI", "laptop", "mcp-prod"). Naming convention "user:<name>" makes
 * grep-ability easy in the DB.
 */
export async function mintApiKeyAction(
  formData: FormData
): Promise<MintedApiKey | MintFailure> {
  assertWritable();
  await requireAuth();
  const orgId = await getOrgId();
  if (!orgId) {
    return { ok: false, error: "Workspace not found." };
  }

  const rawName = String(formData.get("name") ?? "").trim();
  if (!rawName) {
    return { ok: false, error: "Give the key a name (e.g. 'laptop' or 'ci')." };
  }
  if (rawName.length > 60) {
    return { ok: false, error: "Key name must be 60 characters or fewer." };
  }

  const minted = await mintWorkspaceToken(orgId, {
    name: `user:${rawName}`,
    // No `expiresInDays` — long-lived. Operator can revoke from this
    // page; admin-token-expiry behavior is reserved for the
    // create_workspace flow.
  });

  revalidatePath("/settings/api");

  return {
    ok: true,
    token: minted.token,
    prefix: minted.prefix,
    tokenId: minted.tokenId,
    name: rawName,
    expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null,
  };
}

/**
 * Revokes a workspace bearer token by deleting its api_keys row.
 * Scoped to the caller's current workspace — caller can't revoke
 * tokens belonging to other orgs.
 */
export async function revokeApiKeyAction(
  formData: FormData
): Promise<UpdateResult> {
  assertWritable();
  const session = await requireAuth();
  const orgId = await getOrgId();
  if (!orgId) {
    return { ok: false, error: "Workspace not found." };
  }

  const tokenId = String(formData.get("tokenId") ?? "").trim();
  if (!tokenId) {
    return { ok: false, error: "tokenId required." };
  }

  // Defensive: refuse to revoke admin-token (mcp:anonymous-create)
  // entries from a session that's currently bound to one of those
  // tokens — that would log the session out mid-request. Real
  // admin-token revocation should go through the dedicated revoke
  // endpoint, which already handles this safely.
  const isAdminTokenSession = isAdminTokenUserId(session.user.id);

  const [row] = await db
    .select({ id: apiKeys.id, orgId: apiKeys.orgId, name: apiKeys.name })
    .from(apiKeys)
    .where(eq(apiKeys.id, tokenId))
    .limit(1);

  if (!row || row.orgId !== orgId) {
    return { ok: false, error: "Token not found." };
  }

  if (isAdminTokenSession && row.name?.startsWith("mcp:")) {
    return {
      ok: false,
      error:
        "Sign in to revoke admin tokens. Generating an API key here lets you switch off admin-token access safely.",
    };
  }

  await db.delete(apiKeys).where(eq(apiKeys.id, tokenId));
  revalidatePath("/settings/api");
  return { ok: true };
}
