"use server";

// EPIC 2026-10-04 -- staff-side save for the portal "Your services" links (see lib/portal/service-links.ts).

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { getOrgId } from "@/lib/auth/helpers";
import { parseServiceLinks } from "@/lib/portal/service-links";

export async function savePortalServiceLinksAction(input: {
  links: Array<{ label: string; url: string }>;
}): Promise<{ ok: true; saved: number } | { ok: false; error: string }> {
  const orgId = await getOrgId();
  if (!orgId) return { ok: false, error: "unauthorized" };

  const wanted = Array.isArray(input?.links) ? input.links.filter((l) => (l?.label ?? "").trim() || (l?.url ?? "").trim()) : [];
  const links = parseServiceLinks(wanted);
  if (links.length !== wanted.length) {
    return { ok: false, error: "invalid_link: every link needs a label (60 characters max) and a full https:// address" };
  }

  const [row] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!row) return { ok: false, error: "org_not_found" };
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const portal = ((settings.portal ?? {}) as Record<string, unknown>) ?? {};
  await db
    .update(organizations)
    .set({ settings: { ...settings, portal: { ...portal, serviceLinks: links } }, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));

  revalidatePath("/settings/client-portal");
  return { ok: true, saved: links.length };
}
