// Production wiring (server-only): database/env access for the Phone & WhatsApp page. All logic lives in the pure modules.
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { organizations } from "@/db/schema/organizations";
import { makeEvidenceProvider } from "./evidence-provider";
import { EnvLinkStore, OrgSettingsLinkStore, type LinkStore } from "./link-store";
import type { ServiceDeps } from "./service";

function buildStore(): LinkStore {
  // Default = organizations.settings (staff-written, durable). "env" is for previews and staff-managed pilots.
  if (process.env.PHONE_WHATSAPP_LINK_SOURCE === "env") return new EnvLinkStore(process.env.PHONE_WHATSAPP_LINKS_JSON);
  return new OrgSettingsLinkStore({
    async readSettings(orgId) {
      const [row] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return (row?.settings as Record<string, unknown> | undefined) ?? null;
    },
    async findOrgsClaiming(phoneNumberId) {
      const rows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(sql`${organizations.settings} -> 'phoneWhatsapp' -> 'lines' @> ${JSON.stringify([{ phoneNumberId }])}::jsonb`)
        .limit(5);
      return rows.map((r) => r.id);
    },
  });
}

export function getServiceDeps(): ServiceDeps {
  return {
    store: buildStore(),
    provider: makeEvidenceProvider({ baseUrl: process.env.PHONE_EVIDENCE_URL, token: process.env.PHONE_EVIDENCE_TOKEN }),
    now: () => new Date(),
    expectedSipHost: process.env.PHONE_EXPECTED_SIP_HOST ?? null,
  };
}

/** WhatsApp number (digits) of the existing approved EPIC staff contact route. Null = not configured, so the page says so. */
export function getStaffSetupWhatsapp(): string | null {
  const d = (process.env.PHONE_STAFF_SETUP_WHATSAPP ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}
