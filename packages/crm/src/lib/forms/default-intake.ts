// Default public intake form selection (pure; no DB, no Next imports).
//
// 2026-10-21 (Lane A) — replaces the "most recently updated form" pick that
// let an internal staff-feedback form become a workspace's public /intake.
// Only forms EXPLICITLY marked public (intake_forms.settings.public === true)
// are eligible. Among them, in order:
//   1. the owner's explicit choice (organizations.settings.defaultIntakeFormId),
//      if that form is active and public;
//   2. exactly one active public form;
//   3. otherwise none: /intake shows an honest "not available" page and never
//      falls back to another form. A form's slug (even "intake") is not consent
//      to publish it.

/** organizations.settings key holding the owner-chosen default form id. */
export const DEFAULT_INTAKE_FORM_SETTING = "defaultIntakeFormId";

export type IntakeFormCandidate = {
  id: string;
  slug: string;
  isActive: boolean;
  settings: Record<string, unknown> | null | undefined;
};

/** The only publication signal: an explicit `public: true` on the form. */
export function isPublicIntakeEligible(form: Pick<IntakeFormCandidate, "settings">): boolean {
  return form.settings?.public === true;
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

  return eligible.length === 1 ? eligible[0] : null;
}

const INTAKE_DATA_ISLAND = /<script type="application\/json" id="sf-intake-data">([\s\S]*?)<\/script>/;

/**
 * Pre-rendered (formbricks-stack-v1) intake HTML carries its submission target in
 * the `sf-intake-data` JSON island, and its render-time default is "intake". Served
 * at the workspace-default URL, the browser path can't supply the slug either. So the
 * island is re-bound to the resolved form's slug. Returns null when the HTML has no
 * parseable island; the caller must then fail closed rather than serve a form that
 * would submit to the wrong form.
 */
export function bindIntakeDataIslandFormSlug(html: string, formSlug: string): string | null {
  const match = INTAKE_DATA_ISLAND.exec(html);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const json = JSON.stringify({ ...(data as Record<string, unknown>), formSlug }).replace(/</g, "\\u003c");
  return html.slice(0, match.index) + `<script type="application/json" id="sf-intake-data">${json}</script>` + html.slice(match.index + match[0].length);
}
