// packages/crm/src/app/start/onboarding-slugs.ts
// Server-only helpers for the live-sell return page. Moved out of
// app/start/actions.ts ("use server") so they are no longer callable as server
// actions with a caller-supplied agency orgId (Port
// def-uplink-server-actions-caller-supplied-orgid-onboarding-and-portal-admin-2026-10-21).
// The return page passes the signed-in user's own workspace id.

import { and, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { bookings, organizations, partnerAgencies } from "@/db/schema";

// ─── helper: get or create the onboarding-call appointment type ───────────────

export async function getOrCreateOnboardingCallBookingSlug(
  agencyOrgId: string,
): Promise<string> {
  // Look for an existing "Onboarding call" template booking for the agency.
  const [existing] = await db
    .select({ bookingSlug: bookings.bookingSlug })
    .from(bookings)
    .where(
      and(
        eq(bookings.orgId, agencyOrgId),
        eq(bookings.status, "template"),
        ilike(bookings.title, "%onboarding%"),
      ),
    )
    .limit(1);

  if (existing?.bookingSlug) {
    return existing.bookingSlug;
  }

  // None found — create one.
  const slug = "onboarding-call";
  const now = new Date();
  const endsAt = new Date(now.getTime() + 30 * 60_000); // 30 min

  await db.insert(bookings).values({
    orgId: agencyOrgId,
    userId: null as unknown as string,
    title: "Onboarding call",
    bookingSlug: slug,
    fullName: null,
    email: null,
    notes: null,
    provider: "manual",
    status: "template",
    startsAt: now,
    endsAt,
    metadata: {
      kind: "appointment_type",
      durationMinutes: 30,
      description: "30-minute onboarding call to get your workspace set up.",
      price: 0,
      // This is an INTERNAL onboarding call with a client who JUST PAID —
      // it must NOT re-qualify them. Set an explicit minimal field config so
      // the public booking form renders only Phone + a free-text notes box
      // (Full name + Email are rendered natively by PublicBookingForm). Without
      // an explicit intakeFields here, resolvePublicBookingContext falls back to
      // resolveIntakeFieldsFromSoul, which — for a health/wellness agency soul —
      // classifies as a clinical archetype and stamps "Are you a new client?",
      // "What's the matter you'd like to discuss?", "Insurance carrier", etc.
      // onto an internal onboarding call. (See lib/bookings/actions.ts.)
      intakeFields: ONBOARDING_CALL_INTAKE_FIELDS,
    },
  });

  return slug;
}

// Minimal booking-intake fields for the post-checkout onboarding call.
// The client already paid; we just need to reach them and capture an
// optional agenda — no new/returning, insurance, specialist, or
// how-did-you-hear qualification. Full name + Email are rendered by the
// PublicBookingForm itself, so this only declares Phone + the notes box.
const ONBOARDING_CALL_INTAKE_FIELDS = [
  {
    id: "phone",
    label: "Phone",
    type: "tel" as const,
    required: true,
    placeholder: "(555) 123-4567",
  },
  {
    id: "notes",
    label: "Anything you'd like to cover on the call?",
    type: "textarea" as const,
    required: false,
    placeholder: "Optional — questions, goals, or anything we should prep.",
  },
];

// ─── helper: resolve agency slug (for booking URL) ───────────────────────────

export async function getAgencySlug(agencyOrgId: string): Promise<string> {
  // Check partner_agencies first (the canonical source for the agency slug).
  const [agency] = await db
    .select({ slug: partnerAgencies.slug })
    .from(partnerAgencies)
    .where(eq(partnerAgencies.ownerWorkspaceId, agencyOrgId))
    .limit(1);

  if (agency?.slug) return agency.slug;

  // Fallback: the agency's own organization slug.
  const [org] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, agencyOrgId))
    .limit(1);

  return org?.slug ?? "seldon-studio";
}
