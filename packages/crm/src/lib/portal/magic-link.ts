// packages/crm/src/lib/portal/magic-link.ts
// Portal magic-link minting. Moved out of lib/portal/auth.ts ("use server"):
// as an exported server action anyone could call createPortalMagicLink with any
// workspace slug + contact id and receive a signed sign-in link for that
// contact (Port def-uplink-server-actions-caller-supplied-orgid-onboarding-and-portal-admin-2026-10-21).
// It is now a plain server module, callable only from server code that has
// already authorized the caller.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, organizations } from "@/db/schema";
import { signPortalSession } from "./session";

export async function getOrgBySlug(orgSlug: string) {
  // v1.16.1 — also pull `name` so the portal-access-code email can
  // address the customer with the workspace's brand name ("Sign in
  // to Cypress & Pine HVAC") rather than a generic subject.
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  return org ?? null;
}

export function getAppOrigin() {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    "http://localhost:3000"
  );
}

export async function createPortalMagicLink(input: {
  orgSlug: string;
  contactId: string;
  expiresInMinutes?: number;
  redirectTo?: string;
}) {
  const org = await getOrgBySlug(input.orgSlug);

  if (!org) {
    throw new Error("Organization not found");
  }

  const [contact] = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.orgId, org.id), eq(contacts.id, input.contactId)))
    .limit(1);

  if (!contact?.id || !contact.email) {
    throw new Error("Contact must have an email to receive a magic link");
  }

  const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 30) * 60_000);
  const token = signPortalSession({
    orgId: org.id,
    contactId: contact.id,
    email: contact.email,
    exp: expiresAt.getTime(),
  });

  const url = new URL(`/customer/${input.orgSlug}/magic`, getAppOrigin());
  url.searchParams.set("token", token);
  if (input.redirectTo?.trim()) {
    url.searchParams.set("redirect", input.redirectTo.trim());
  }

  return {
    token,
    inviteUrl: url.toString(),
    expiresAt: expiresAt.toISOString(),
    contact: {
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
    },
  };
}
