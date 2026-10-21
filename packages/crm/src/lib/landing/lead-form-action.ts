"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, organizations } from "@/db/schema";
import { assertWritable as assertWritableImpl } from "@/lib/demo/server";
import { enforceContactLimit as enforceContactLimitImpl } from "@/lib/billing/limits";
import { emitSeldonEvent } from "@/lib/events/bus";
import { findContactByPhone as findContactByPhoneImpl } from "@/lib/sms/api";
import { sendSmsFromApi } from "@/lib/sms/api";
import { normalizePhone } from "@/lib/sms/suppression";
import { buildWorkspaceUrls } from "@/lib/billing/anonymous-workspace";
import { sendNewLeadAlert } from "@/lib/notifications/ops-notifications";
import type { LimitDecision } from "@/lib/billing/limits";
import { submitLeadFormWithDeps, type LeadFormInput, type LeadFormActionResult, type LeadFormDeps } from "./lead-form-core";

// ── Public contract ───────────────────────────────────────────────────────

// ── Injectable boundary (the repo's testable-deps idiom; see
//    src/lib/events/listeners-testable.ts). The "use server" action below
//    wires the production implementations; unit tests inject fakes so no
//    DB / Twilio / Resend is touched. ───────────────────────────────────────

// ── Production deps factory ──────────────────────────────────────────────

function makeDefaultDeps(): LeadFormDeps {
  return {
    assertWritable: assertWritableImpl,
    resolveOrgIdBySlug: async (slug) => {
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      return org?.id ?? null;
    },
    enforceContactLimit: enforceContactLimitImpl,
    findContactByPhone: findContactByPhoneImpl,
    getContactById: async (orgId, contactId) => {
      const [row] = await db
        .select({ firstName: contacts.firstName, lastName: contacts.lastName })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
        .limit(1);
      return row ?? null;
    },
    createContact: async (values) => {
      const [row] = await db.insert(contacts).values(values).returning({ id: contacts.id });
      if (!row) throw new Error("Could not create contact");
      return row.id;
    },
    updateContact: async (contactId, patch) => {
      await db.update(contacts).set(patch).where(eq(contacts.id, contactId));
    },
    emit: (type, data, orgId) =>
      emitSeldonEvent(
        type,
        // The bus is generically typed; both event shapes are satisfied by
        // the records we build in the core.
        data as never,
        { orgId },
      ),
    buildBookUrl: (slug, orgId) =>
      buildWorkspaceUrls(slug, process.env.WORKSPACE_BASE_DOMAIN ?? "app.seldonframe.com", orgId).book,
    sendSms: async ({ orgId, contactId, toNumber, body }) => {
      const res = await sendSmsFromApi({ orgId, userId: null, contactId, toNumber, body });
      return { suppressed: res.suppressed };
    },
    sendOperatorEmail: (params) => sendNewLeadAlert(params),
    getBusinessName: async (orgId) => {
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return org?.name ?? "us";
    },
    now: () => new Date(),
  };
}

/**
 * The "use server" action the client form imports directly (mirrors
 * components/bookings/public-booking-form.tsx importing submitPublicBookingAction).
 * Thin wrapper over the injectable core with production deps.
 */
export async function submitLeadFormAction(input: LeadFormInput): Promise<LeadFormActionResult> {
  return submitLeadFormWithDeps(input, makeDefaultDeps());
}
