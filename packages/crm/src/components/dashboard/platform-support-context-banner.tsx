import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, users } from "@/db/schema";
import { resolveOperatorPortalContext } from "@/lib/auth/operator-portal-context";
import { exitPlatformSupportSessionAction } from "@/lib/operator-portal/support-session";

export async function PlatformSupportContextBanner() {
  const context = await resolveOperatorPortalContext();
  const originUserId = context?.user.supportOriginUserId;
  const supportSessionId = context?.user.supportSessionId;
  if (!context || !originUserId || !supportSessionId) return null;
  const [[tenant], [operator]] = await Promise.all([
    db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, context.orgId)).limit(1),
    db.select({ email: users.email }).from(users).where(eq(users.id, originUserId)).limit(1),
  ]);
  return (
    <aside className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950" aria-label="Platform support session">
      <div><strong>Platform support session</strong><span className="mx-2">·</span>Active tenant: <strong>{tenant?.name ?? context.orgSlug}</strong><span className="mx-2">·</span>Operator: {operator?.email ?? "unknown"}</div>
      <form action={exitPlatformSupportSessionAction}><button type="submit" className="rounded-md border border-amber-800 px-3 py-1.5 font-semibold">Exit support session</button></form>
    </aside>
  );
}
