// Default public intake form selection (pure; no DB, no Next imports).
//
// 2026-10-21 (Lane A) — replaces the "most recently updated form" pick that
// let an internal staff-feedback form become a workspace's public /intake.
// Rules, in order:
//   1. The owner's explicit choice (organizations.settings.defaultIntakeFormId),
//      only if that form is active AND public-eligible.
//   2. The platform-seeded form whose slug is literally "intake" — this is the
//      exact form today's /intake fallback already serves, so those
//      workspaces keep resolving exactly as before.
//   3. Exactly one active form explicitly marked public (settings.public === true).
//   4. Otherwise: none. /intake then shows an honest "not available" page;
//      it never falls back to an internal form.

/** Path segment the proxy rewrites bare /intake and /forms to. toSlug() strips
 *  underscores, so no operator-created form can ever carry this slug. */
export const WORKSPACE_DEFAULT_FORM_SLUG = "__workspace-default";

/** The slug the platform seeds for a workspace's public intake form. */
export const LEGACY_PUBLIC_INTAKE_SLUG = "intake";

/** organizations.settings key holding the owner-chosen default form id. */
export const DEFAULT_INTAKE_FORM_SETTING = "defaultIntakeFormId";

export type IntakeFormCandidate = {
  id: string;
  slug: string;
  isActive: boolean;
  settings: Record<string, unknown> | null | undefined;
};

export function isExplicitlyPublicForm(form: Pick<IntakeFormCandidate, "settings">): boolean {
  return form.settings?.public === true;
}

/** A form may be the workspace's public default only if it is explicitly
 *  marked public, or is the platform-seeded public "intake" form. */
export function isPublicIntakeEligible(form: Pick<IntakeFormCandidate, "slug" | "settings">): boolean {
  return isExplicitlyPublicForm(form) || form.slug === LEGACY_PUBLIC_INTAKE_SLUG;
}

export function readDefaultIntakeFormId(orgSettings: unknown): string | null {
  if (!orgSettings || typeof orgSettings !== "object") return null;
  const value = (orgSettings as Record<string, unknown>)[DEFAULT_INTAKE_FORM_SETTING];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveDefaultIntakeForm<T extends IntakeFormCandidate>(input: {
  forms: readonly T[];
  defaultIntakeFormId: string | null;
}): T | null {
  const eligible = input.forms.filter((form) => form.isActive && isPublicIntakeEligible(form));

  if (input.defaultIntakeFormId) {
    const chosen = eligible.find((form) => form.id === input.defaultIntakeFormId);
    if (chosen) return chosen;
  }

  const legacy = eligible.find((form) => form.slug === LEGACY_PUBLIC_INTAKE_SLUG);
  if (legacy) return legacy;

  const explicitlyPublic = eligible.filter(isExplicitlyPublicForm);
  return explicitlyPublic.length === 1 ? explicitlyPublic[0] : null;
}
