import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, partnerAgencies, users } from "@/db/schema";
import { assertUplinkFixtureTarget, UPLINK_FIXTURE_WORKSPACES } from "@/lib/platform/uplink-contracts";

const marker = "uplink-phase1-synthetic";
const now = new Date();

async function main() {
  assertUplinkFixtureTarget(process.env);

  await db.transaction(async (tx) => {
    const ensured = new Map<string, { id: string; ownerId: string }>();

    for (const fixture of UPLINK_FIXTURE_WORKSPACES) {
      const email = `${fixture.slug}@example.invalid`;
      let [org] = await tx.select().from(organizations).where(eq(organizations.slug, fixture.slug)).limit(1);

      if (org && org.settings?.uplinkFixture !== marker) {
        throw new Error(`Refusing to modify unmarked workspace slug: ${fixture.slug}`);
      }
      if (!org) {
        [org] = await tx.insert(organizations).values({
          name: fixture.offer === "personal-line" ? "Uplink Demo Personal Line"
            : fixture.offer === "business-front-office" ? "Uplink Demo Business"
              : fixture.offer === "agency-parent" ? "Uplink Demo Agency"
                : "Uplink Demo Agency Client",
          slug: fixture.slug,
          plan: "free",
          isInternal: true,
          previewMode: true,
          testMode: true,
          settings: {
            uplinkFixture: marker,
            offerFamily: fixture.offer,
            externalAi: false,
            chatwoot: false,
            epicVoice: false,
            syntheticOnly: true,
          },
        }).returning();
      }
      if (!org) throw new Error(`Could not create fixture workspace: ${fixture.slug}`);

      let [owner] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (owner && owner.orgId !== org.id) {
        throw new Error(`Fixture owner email is already attached elsewhere: ${email}`);
      }
      if (!owner) {
        [owner] = await tx.insert(users).values({
          orgId: org.id,
          name: "Uplink Synthetic Operator",
          email,
          role: "owner",
          passwordHash: null,
          emailVerified: null,
          onboardingCompletedAt: now,
        }).returning();
      }
      if (!owner) throw new Error(`Could not create fixture owner: ${fixture.slug}`);

      await tx.update(organizations).set({
        ownerId: owner.id,
        isInternal: true,
        previewMode: true,
        testMode: true,
        updatedAt: now,
      }).where(eq(organizations.id, org.id));

      ensured.set(fixture.slug, { id: org.id, ownerId: owner.id });
    }

    const parent = ensured.get("uplink-demo-agency")!;
    const child = ensured.get("uplink-demo-agency-client")!;
    let [agency] = await tx.select().from(partnerAgencies)
      .where(eq(partnerAgencies.slug, "uplink-demo-agency")).limit(1);

    if (agency && (agency.ownerWorkspaceId !== parent.id || agency.ownerUserId !== parent.ownerId)) {
      throw new Error("Refusing to reuse an agency fixture with mismatched ownership");
    }
    if (!agency) {
      [agency] = await tx.insert(partnerAgencies).values({
        name: "Uplink Demo Agency",
        slug: "uplink-demo-agency",
        ownerWorkspaceId: parent.id,
        ownerUserId: parent.ownerId,
        status: "pending",
        hidePoweredByBadge: false,
      }).returning();
    }
    if (!agency) throw new Error("Could not create the synthetic agency parent");

    await tx.update(organizations).set({
      parentAgencyId: agency.id,
      updatedAt: now,
    }).where(eq(organizations.id, child.id));
  });

  console.log(`Synthetic Uplink fixtures ready: ${UPLINK_FIXTURE_WORKSPACES.map((f) => f.slug).join(", ")}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown fixture error";
  console.error(`Uplink fixture creation failed: ${message}`);
  process.exitCode = 1;
});
