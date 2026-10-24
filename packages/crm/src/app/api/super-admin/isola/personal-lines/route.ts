import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { isSuperAdminUser } from "@/lib/auth/super-admin";
import { db } from "@/db";
import { contacts, deals } from "@/db/schema";

export const dynamic = "force-dynamic";

const endpoint = (path: string) => {
  const base = process.env.PERSONAL_LINE_BFF_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
};

function secretFromFile(pathVariable: string): string | null {
  const path = process.env[pathVariable];
  if (!path) return null;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length >= 32 ? value : null;
  } catch {
    return null;
  }
}

async function operator() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !(await isSuperAdminUser(email))) return null;
  return email;
}

function unavailable() {
  return NextResponse.json({ error: "personal_line_service_unavailable" }, { status: 503 });
}

export async function GET(request: NextRequest) {
  if (!(await operator())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const q = (request.nextUrl.searchParams.get("q") ?? "").replace(/\D/g, "");
  if (request.nextUrl.searchParams.has("q") && q.length < 4) {
    return NextResponse.json({ error: "search_requires_four_digits" }, { status: 400 });
  }
  const url = endpoint("/api/internal/personal-line/accounts");
  const credential = secretFromFile("PERSONAL_LINE_READ_TOKEN_FILE");
  if (!url || !credential) return unavailable();

    const accounts: Record<string, unknown>[] = [];
    const accountIdsByRow = new Map<Record<string, unknown>, string>();
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 50; page += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pl-operator-read-token": credential,
        },
        body: JSON.stringify({ cursor, limit: 100, retired: "include", includeKnownFixtures: true }),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return unavailable();
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") return unavailable();
      const data = body as { status?: unknown; accounts?: unknown; total?: unknown; listener?: unknown; nextCursor?: unknown };
      if (data.status !== "ok" || !Array.isArray(data.accounts) || !Number.isInteger(data.total) || !data.listener || typeof data.listener !== "object" || !(data.nextCursor === null || typeof data.nextCursor === "string")) return unavailable();
      for (const row of data.accounts) {
        if (!row || typeof row !== "object") return unavailable();
        const account = row as Record<string, unknown>;
        if (typeof account.liteAccountId !== "string" || seenIds.has(account.liteAccountId) || !(account.did === null || typeof account.did === "string") || !(account.ownerPhone === null || typeof account.ownerPhone === "string") || typeof account.isFixture !== "boolean" || typeof account.createdAt !== "string" || typeof account.identity !== "string" || !account.registration || typeof account.registration !== "object") return unavailable();
        seenIds.add(account.liteAccountId);
        const registration = account.registration as Record<string, unknown>;
        const evidence = account.evidence && typeof account.evidence === "object" ? account.evidence as Record<string, unknown> : null;
        const activationLink = registration.activationLink && typeof registration.activationLink === "object" ? registration.activationLink as Record<string, unknown> : null;
        const projected: Record<string, unknown> = {
          did: account.did,
          ownerPhone: account.ownerPhone,
          createdAt: account.createdAt,
          registration: {
            state: registration.registration,
            reason: registration.reason,
            handoffAt: registration.handoffAt,
            registeredAt: registration.registeredAt,
            checkedAt: registration.checkedAt,
            activationLink: activationLink ? {
              state: activationLink.state,
              createdAt: activationLink.createdAt,
              expiresAt: activationLink.expiresAt,
              usedAt: activationLink.usedAt,
            } : null,
          },
          evidence: evidence ? {
            paidPayments: evidence.paidPayments,
            completedWalletMovements: evidence.completedWalletMovements,
            unresolvedClaims: evidence.unresolvedClaims,
          } : null,
          identity: account.identity,
          isFixture: account.isFixture,
        };
        accounts.push(projected);
        accountIdsByRow.set(projected, account.liteAccountId);
      }
      if (data.nextCursor === null) {
        const searchMatches = q.length >= 4 ? accounts.filter((row) => `${row.did}${row.ownerPhone}`.replace(/\D/g, "").includes(q)) : accounts;
        const lifecycle = new Map<string, { stage: string; updatedAt: string; workspaceId: string; contactId: string }>();
        const accountIds = Array.from(accountIdsByRow.values());
        if (accountIds.length) {
          const rows = await db.select({
            accountId: sql<string>`${deals.customFields}->>'plAccountId'`,
            stage: deals.stage,
            updatedAt: deals.updatedAt,
            contactId: deals.contactId,
            orgId: deals.orgId,
            source: sql<string>`${deals.customFields}->>'source'`,
          }).from(deals).innerJoin(contacts, eq(contacts.id, deals.contactId))
            .where(inArray(sql<string>`${deals.customFields}->>'plAccountId'`, accountIds))
            .orderBy(desc(deals.updatedAt));
          for (const row of rows) {
            if (row.source !== "personal_line" || !row.accountId || !row.stage || !row.contactId || !row.orgId || lifecycle.has(row.accountId)) continue;
            lifecycle.set(row.accountId, {
              stage: row.stage,
              updatedAt: row.updatedAt.toISOString(),
              workspaceId: row.orgId,
              contactId: row.contactId,
            });
          }
        }
        const withLifecycle = searchMatches.map((row) => ({
          ...row,
          lifecycle: lifecycle.get(accountIdsByRow.get(row) ?? "") ?? null,
        }));
        const supportBase = process.env.CHATWOOT_LINK_PUBLIC_URL?.replace(/\/+$/, "");
        const accountId = process.env.UPLINK_RELAY_CHATWOOT_ACCOUNT_ID;
        const inboxId = process.env.UPLINK_RELAY_CHATWOOT_INBOX_ID;
        const supportUrl = supportBase && accountId && inboxId ? `${supportBase}/app/accounts/${encodeURIComponent(accountId)}/inbox/${encodeURIComponent(inboxId)}` : null;
        return NextResponse.json({ accounts: withLifecycle, total: withLifecycle.length, supportUrl }, { headers: { "Cache-Control": "no-store" } });
      }
      if (data.nextCursor === cursor || seenCursors.has(data.nextCursor)) return unavailable();
      seenCursors.add(data.nextCursor);
      cursor = data.nextCursor;
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

export async function POST(request: NextRequest) {
  const actor = await operator();
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = endpoint("/api/internal/personal-line/fixture-reset");
  const credential = secretFromFile("PERSONAL_LINE_WRITE_TOKEN_FILE");
  if (!url || !credential) return unavailable();
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const mode = body.magnusUser === "delete" ? "delete" : body.magnusUser === "deactivate" ? "deactivate" : null;
  const action = body.action;
  if (!phone || phone.length > 32 || !mode || (action !== "preview" && action !== "confirm")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const dryRun = action === "preview";
  if (!dryRun && (typeof body.previewReceipt !== "string" || !body.previewReceipt || typeof body.operatorReason !== "string" || !body.operatorReason.trim() || body.operatorReason.length > 2000)) {
    return NextResponse.json({ error: "preview_and_reason_required" }, { status: 400 });
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pl-operator-write-token": credential },
      body: JSON.stringify({
        targetPhone: phone,
        dryRun,
        magnusUser: mode,
        ...(dryRun ? {} : { previewReceipt: body.previewReceipt, actor, operatorReason: body.operatorReason }),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (![200, 207, 400, 403, 409, 503].includes(response.status)) return unavailable();
    const result: unknown = await response.json();
    return NextResponse.json(result, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return unavailable();
  }
}
