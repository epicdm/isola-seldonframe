import { eq, and, desc } from "drizzle-orm";
import { Globe, Building2, Clock, KeyRound, ChevronRight } from "lucide-react";
import Link from "next/link";
import { db } from "@/db";
import { apiKeys, intakeForms, organizations } from "@/db/schema";
import { isPublicIntakeEligible, readDefaultIntakeFormId, resolveDefaultIntakeForm } from "@/lib/forms/default-intake";
import { setDefaultIntakeFormAction } from "@/lib/forms/actions";
import { getOrgId, requireAuth } from "@/lib/auth/helpers";
import { isAdminTokenUserId } from "@/lib/auth/admin-token";
import { updateWorkspaceSettingsAction } from "@/lib/workspace/actions";
import { COMMON_TIMEZONES } from "@/lib/workspace/timezones";
import { resolveWorkspaceBaseDomain } from "@/lib/branding/platform";

/**
 * Server-action wrapper that adapts the typed result to the
 * `Promise<void>` shape Next.js' `<form action={...}>` expects. On
 * failure the error gets logged server-side; the page reloads either
 * way so the operator sees the post-mutation state. (For an interactive
 * toast, swap in a client component + useTransition.)
 */
async function updateWorkspaceFormHandler(formData: FormData): Promise<void> {
  "use server";
  const result = await updateWorkspaceSettingsAction(formData);
  if (!result.ok) {
    console.warn("[settings/workspace] save failed:", result.error);
  }
}

/**
 * P0-4: workspace identity settings.
 *
 * Houses the operational fields that drive scheduled-trigger fire times,
 * billing-receipt routing, and the admin-token UX. Existed-but-not-
 * surfaced before this commit:
 *   - `organizations.timezone` (added in migration 0022; no UI to set)
 *   - `organizations.name` (editable via /settings/profile but mixed in
 *     with soul context — operators didn't expect a "business name" form
 *     to also rename the workspace)
 *
 * The admin-token expiration card is shown only for guest sessions —
 * tells the operator their bearer URL is time-bound and points them at
 * /settings/api to mint a permanent SELDONFRAME_API_KEY.
 */
export default async function WorkspaceSettingsPage() {
  const session = await requireAuth();
  const orgId = await getOrgId();
  const workspaceBaseDomain = resolveWorkspaceBaseDomain();
  const isGuestAdminToken = isAdminTokenUserId(session.user.id);

  if (!orgId) {
    return (
      <section className="animate-page-enter space-y-4">
        <h1 className="text-lg font-semibold">Workspace</h1>
        <p className="text-sm text-muted-foreground">No active workspace.</p>
      </section>
    );
  }

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      timezone: organizations.timezone,
      ownerId: organizations.ownerId,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    return (
      <section className="animate-page-enter space-y-4">
        <h1 className="text-lg font-semibold">Workspace</h1>
        <p className="text-sm text-muted-foreground">Workspace not found.</p>
      </section>
    );
  }

  const workspaceForms = await db
    .select({ id: intakeForms.id, slug: intakeForms.slug, name: intakeForms.name, isActive: intakeForms.isActive, settings: intakeForms.settings })
    .from(intakeForms)
    .where(eq(intakeForms.orgId, org.id));
  const chosenDefaultFormId = readDefaultIntakeFormId(org.settings);
  const defaultIntakeForm = resolveDefaultIntakeForm({ forms: workspaceForms, defaultIntakeFormId: chosenDefaultFormId });
  const publicForms = workspaceForms.filter((form) => form.isActive && isPublicIntakeEligible(form));

  // Find the most-recent admin-token (mcp:anonymous-create or mcp:device)
  // for the expiration display. Only relevant for guest sessions.
  let adminTokenExpiresAt: Date | null = null;
  if (isGuestAdminToken) {
    const [latest] = await db
      .select({ expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, org.id), eq(apiKeys.kind, "workspace")))
      .orderBy(desc(apiKeys.createdAt))
      .limit(1);
    adminTokenExpiresAt = latest?.expiresAt ?? null;
  }

  return (
    <section className="animate-page-enter space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-lg sm:text-[22px] font-semibold leading-relaxed text-foreground">
          Workspace settings
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Workspace name, timezone, and access tokens. These drive scheduled
          automations, billing-receipt routing, and the admin URL.
        </p>
      </div>

      {/* Identity form */}
      <form action={updateWorkspaceFormHandler} className="rounded-xl border bg-card p-5 space-y-5">
        <div className="flex items-center gap-2 pb-2 border-b">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Identity</h2>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="ws-name"
              className="block text-xs uppercase tracking-wide font-medium text-muted-foreground mb-1.5"
            >
              Workspace name
            </label>
            <input
              id="ws-name"
              name="name"
              type="text"
              required
              maxLength={80}
              defaultValue={org.name}
              className="w-full rounded-lg border border-border bg-background py-2 px-3 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Shown in the navbar, footer, and on every public page. Slug stays{" "}
              <code className="font-mono text-foreground">{org.slug}</code>.
            </p>
          </div>

          <div>
            <label
              htmlFor="ws-timezone"
              className="block text-xs uppercase tracking-wide font-medium text-muted-foreground mb-1.5"
            >
              Timezone
            </label>
            <div className="relative">
              <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <select
                id="ws-timezone"
                name="timezone"
                defaultValue={org.timezone}
                className="w-full appearance-none rounded-lg border border-border bg-background py-2 pl-9 pr-8 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 h-3 w-3 text-muted-foreground pointer-events-none" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Drives scheduled-trigger fire times, business-hours computation, and
              date displays in dashboard widgets. IANA zone names — match what
              the customer sees, not the operator's location.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-foreground">
            Slug + workspace ID are immutable. Want a different slug?{" "}
            Contact your platform operator to discuss a workspace URL change.
          </p>
          <button type="submit" className="crm-button-primary h-10 px-5">
            Save changes
          </button>
        </div>
      </form>

      {/* Admin-token info — only for guest sessions */}
      {isGuestAdminToken ? (
        <div className="rounded-xl border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Admin URL access</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            You're signed in via a guest admin URL. Your access expires{" "}
            {adminTokenExpiresAt ? (
              <strong className="text-foreground">
                {adminTokenExpiresAt.toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </strong>
            ) : (
              <strong className="text-foreground">in 7 days</strong>
            )}
            . For permanent access, generate an API key (also works as your{" "}
            <code className="font-mono text-foreground">SELDONFRAME_API_KEY</code> for
            the MCP server).
          </p>
          <div className="flex items-center gap-2">
            <Link
              href="/settings/api"
              className="crm-button-primary inline-flex h-9 items-center px-4 text-sm gap-1.5"
            >
              Generate API key <ChevronRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href="/settings/billing"
              className="crm-button-secondary inline-flex h-9 items-center px-4 text-sm"
            >
              Or upgrade + claim
            </Link>
          </div>
        </div>
      ) : null}

      {/* Quick stats */}
      <div className="rounded-xl border bg-card p-5 space-y-2">
        <div className="flex items-center gap-2 pb-2 border-b">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Public URLs</h2>
        </div>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center justify-between">
            <span className="text-muted-foreground">Landing</span>
            <a
              href={`https://${org.slug}.${workspaceBaseDomain}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:underline font-mono text-xs"
            >
              {org.slug}.{workspaceBaseDomain}
            </a>
          </li>
          <li className="flex items-center justify-between">
            <span className="text-muted-foreground">Booking</span>
            <a
              href={`https://${org.slug}.${workspaceBaseDomain}/book`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:underline font-mono text-xs"
            >
              {org.slug}.{workspaceBaseDomain}/book
            </a>
          </li>
          <li className="flex items-center justify-between">
            <span className="text-muted-foreground">Intake</span>
            {defaultIntakeForm ? (
              <a
                href={`https://${org.slug}.${workspaceBaseDomain}/intake`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground hover:underline font-mono text-xs"
                title={defaultIntakeForm.name}
              >
                {org.slug}.{workspaceBaseDomain}/intake
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">
                No public intake form yet.{" "}
                <Link href="/forms" className="underline">
                  Mark a form public
                </Link>
              </span>
            )}
          </li>
        </ul>
        <form action={setDefaultIntakeFormAction} className="flex flex-wrap items-center gap-2 pt-2">
          <label htmlFor="ws-default-intake" className="text-xs text-muted-foreground">
            Default intake form
          </label>
          <select
            id="ws-default-intake"
            name="defaultIntakeFormId"
            defaultValue={chosenDefaultFormId ?? ""}
            className="rounded-lg border border-border bg-background py-1.5 px-2 text-xs"
          >
            <option value="">Automatic (only public forms)</option>
            {publicForms.map((form) => (
              <option key={form.id} value={form.id}>
                {form.name} (/{form.slug})
              </option>
            ))}
          </select>
          <button type="submit" className="crm-button-secondary h-8 px-3 text-xs">
            Save
          </button>
        </form>
        <p className="text-xs text-muted-foreground pt-1">
          Want a custom domain? See{" "}
          <Link href="/settings/domain" className="underline">
            Domain settings
          </Link>{" "}
          (Growth + Scale).
        </p>
      </div>
    </section>
  );
}
