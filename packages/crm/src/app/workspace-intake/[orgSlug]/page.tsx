// Workspace-default intake: the proxy rewrites a workspace host's bare /intake and
// /forms here. It is a separate route, so it can never collide with a real form slug.
// It renders the workspace's public default form (lib/forms/default-intake.ts) through
// the normal public form page. With no public default it shows an honest
// "not available" 404, never another form.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { loadDefaultIntakeForm } from "@/lib/forms/default-intake-server";
import PublicIntakePage, { generateMetadata as generateFormMetadata } from "@/app/forms/[id]/[formSlug]/page";

async function resolveDefaultSlug(orgSlug: string): Promise<string | null> {
  const [org] = await db
    .select({ id: organizations.id, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  if (!org) return null;
  return (await loadDefaultIntakeForm(org.id, org.settings))?.slug ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ orgSlug: string }> }): Promise<Metadata> {
  const { orgSlug } = await params;
  const formSlug = await resolveDefaultSlug(orgSlug);
  if (!formSlug) return { title: "Form not available", robots: { index: false, follow: false } };
  return generateFormMetadata({ params: Promise.resolve({ id: orgSlug, formSlug }) });
}

export default async function WorkspaceDefaultIntakePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const formSlug = await resolveDefaultSlug(orgSlug);
  if (!formSlug) {
    notFound();
  }
  return PublicIntakePage({ params: Promise.resolve({ id: orgSlug, formSlug }), bindDataIslandSlug: true });
}
