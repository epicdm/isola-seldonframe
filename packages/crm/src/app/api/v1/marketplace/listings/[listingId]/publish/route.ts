import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { marketplaceListings } from "@/db/schema";
import { assertWritable, demoApiBlockedResponse, isDemoReadonly } from "@/lib/demo/server";
import { workspaceAdminRouteRefusal } from "@/lib/auth/require-workspace-role";
import { workspaceAdminRouteRefusalFor } from "@/lib/auth/require-workspace-role";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ listingId: string }> }
) {
  const staffRefusal = await workspaceAdminRouteRefusal();
  if (staffRefusal) return staffRefusal;
  if (isDemoReadonly()) {
    return demoApiBlockedResponse();
  }

  assertWritable();

  const session = await auth();
  if (!session?.user?.id || !session.user.orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const targetRefusal = await workspaceAdminRouteRefusalFor(session.user.orgId);
  if (targetRefusal) return targetRefusal;

  const { listingId } = await params;

  const [listing] = await db
    .select({
      id: marketplaceListings.id,
      price: marketplaceListings.price,
      stripeConnectAccountId: marketplaceListings.stripeConnectAccountId,
    })
    .from(marketplaceListings)
    .where(
      and(
        eq(marketplaceListings.id, listingId),
        eq(marketplaceListings.creatorOrgId, session.user.orgId)
      )
    )
    .limit(1);

  if (!listing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (listing.price > 0 && !listing.stripeConnectAccountId) {
    return NextResponse.json({ error: "Connect Stripe to sell paid souls" }, { status: 400 });
  }

  await db
    .update(marketplaceListings)
    .set({ isPublished: true, updatedAt: new Date() })
    .where(eq(marketplaceListings.id, listing.id));

  return NextResponse.json({ success: true });
}
