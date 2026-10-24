import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const enabled = process.env.PL_VERTICAL_PACK_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

test("VerticalPack installation is retry-safe and preserves sibling workspace settings", { skip: !enabled && "set PL_VERTICAL_PACK_DB_TEST=scratch with a scratch database" }, async () => {
  const { db } = await import("@/db");
  const { organizations } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { installVerticalPack } = await import("@/lib/openclaw/vertical-packs");
  const orgId = randomUUID();
  const slug = `vertical-pack-retry-${randomUUID().slice(0, 8)}`;

  await db.insert(organizations).values({
    id: orgId,
    name: "Synthetic vertical pack retry fixture",
    slug,
    settings: { billing: { preserved: true }, verticalPacks: { "personal-line": { installed_at: "2026-01-01T00:00:00.000Z", legacy: true } } },
    enabledBlocks: ["forms"],
  });
  try {
    const pack = {
      schema_version: "1.0" as const,
      id: "personal-line",
      name: "Personal Line workspace setup",
      tagline: "Observe Personal Line onboarding inside the customer workspace.",
      industry: "telecommunications",
      description: "Synthetic fixture pack for installer idempotency verification.",
      soul_hints: { audience_type: "service" as const, tone: "clear, careful", tagline_suggestion: "Connected service support." },
      objects: [
        { key: "service", label_singular: "Service", label_plural: "Services", description: "Workspace service.", fields: [{ key: "name", label: "Name", type: "text" as const }] },
        { key: "line_event", label_singular: "Line Event", label_plural: "Line Events", description: "Lifecycle event.", fields: [{ key: "event_type", label: "Event Type", type: "text" as const }] },
      ],
      relations: [{ from_object: "contact", to_object: "service", kind: "one_to_many" as const, description: "A customer may have multiple services." }],
      views: [
        { object_key: "service", name: "Customer services", description: "Services associated with workspace customers.", layout: "table" as const },
        { object_key: "line_event", name: "Recent line events", description: "Recent lifecycle observations.", layout: "table" as const },
      ],
      permissions: [{ role: "owner", object_key: "service", can_read: true, can_write: true, can_delete: false }],
      workflows: [{ name: "Onboarding support", trigger: "lifecycle event received", description: "Review verified lifecycle evidence.", steps: ["open tenant-scoped Personal Lines view"] }],
      block_ids: ["forms", "bookings"],
      generated_by: "builtin" as const,
    };

    const [first, second] = await Promise.all([
      installVerticalPack(orgId, pack),
      installVerticalPack(orgId, pack),
    ]);
    const [stored] = await db.select({ settings: organizations.settings, enabledBlocks: organizations.enabledBlocks })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);

    assert.equal(first.installedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(second.installedAt, first.installedAt);
    assert.deepEqual(stored.enabledBlocks?.sort(), ["bookings", "forms"]);
    assert.deepEqual((stored.settings as Record<string, unknown>).billing, { preserved: true });
    const packs = (stored.settings as Record<string, unknown>).verticalPacks as Record<string, Record<string, unknown>>;
    assert.equal(packs["personal-line"].installed_at, first.installedAt);
    assert.equal("legacy" in packs["personal-line"], false);
  } finally {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
});
