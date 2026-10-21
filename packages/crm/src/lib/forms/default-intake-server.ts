import { eq } from "drizzle-orm";
import { db } from "@/db";
import { intakeForms, organizations } from "@/db/schema";
import { readDefaultIntakeFormId, resolveDefaultIntakeForm } from "@/lib/forms/default-intake";

/** Loads a workspace's forms and returns its public default intake form
 *  (see lib/forms/default-intake.ts for the rules), or null. */
export async function loadDefaultIntakeForm(orgId: string, orgSettings?: unknown) {
  let settings = orgSettings;
  if (settings === undefined) {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    settings = org?.settings ?? null;
  }

  const forms = await db
    .select({
      id: intakeForms.id,
      slug: intakeForms.slug,
      name: intakeForms.name,
      isActive: intakeForms.isActive,
      settings: intakeForms.settings,
    })
    .from(intakeForms)
    .where(eq(intakeForms.orgId, orgId));

  return resolveDefaultIntakeForm({ forms, defaultIntakeFormId: readDefaultIntakeFormId(settings) });
}
