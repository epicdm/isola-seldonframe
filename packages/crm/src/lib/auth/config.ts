import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { db } from "@/db";
import { accounts, organizations, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { sendNewSignupAlert } from "@/lib/notifications/ops-notifications";
import { createPlatformVerificationEmailSender, formatBrandedSender, hasPlatformSignInEmailTransport } from "./signin-email";
import { resolvePlatformBranding } from "@/lib/branding/platform";
// funnel.ts (posthog-node) is imported lazily below, not statically here —
// config.ts sits in the proxy/middleware module graph (config -> auth ->
// src/proxy.ts), and a static import would pull posthog-node into that
// bundle for every request, not just the rare createUser event.

const BILLING_STATUSES = ["trialing", "active", "past_due", "canceled", "unpaid"] as const;
const BILLING_PERIODS = ["monthly", "yearly"] as const;
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const resendApiKey = (process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY)?.trim();
const platformBrand = resolvePlatformBranding();
const resendFrom = (
  process.env.AUTH_RESEND_FROM ??
  process.env.DEFAULT_FROM_EMAIL ??
  process.env.PORTAL_EMAIL_FROM ??
  `${platformBrand.emailFromName} <${platformBrand.supportEmail}>`
).trim();

function normalizeBillingStatus(value: string | null | undefined): (typeof BILLING_STATUSES)[number] {
  return BILLING_STATUSES.includes(value as (typeof BILLING_STATUSES)[number])
    ? (value as (typeof BILLING_STATUSES)[number])
    : "trialing";
}

function normalizeBillingPeriod(value: string | null | undefined): (typeof BILLING_PERIODS)[number] {
  return BILLING_PERIODS.includes(value as (typeof BILLING_PERIODS)[number])
    ? (value as (typeof BILLING_PERIODS)[number])
    : "monthly";
}

const authProviders: NextAuthConfig["providers"] = [];

if (googleClientId && googleClientSecret) {
  authProviders.push(
    Google({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      // 2026-05-17 — production smoke test surfaced OAuthAccountNotLinked
      // errors when an operator who signed up via email magic-link later
      // tried "Sign in with Google" with the same address. NextAuth's
      // default policy is to refuse silent linking across providers
      // because an attacker controlling an unverified OAuth provider
      // could hijack the email-based account.
      //
      // For Google specifically this is safe — Google verifies the
      // email before issuing the OAuth token, so receiving a Google
      // session for X means the holder really controls X. Setting
      // `allowDangerousEmailAccountLinking: true` is the documented
      // NextAuth way to opt INTO same-email linking for trusted
      // providers. See https://authjs.dev/getting-started/providers/google
      allowDangerousEmailAccountLinking: true,
    })
  );
}


if (hasPlatformSignInEmailTransport(process.env)) {
  authProviders.push(
    Resend({
      apiKey: resendApiKey,
      from: formatBrandedSender(resendFrom, platformBrand.emailFromName),
      // Keep provider defaults minimal; the returned callback is replaced below.
      // template. The default ships a generic "Sign in" button with no brand
      // context — on a fresh signup the recipient sees a blue blob from a
      // domain they may not recognize, which trips spam filters and erodes
      // trust on the very first touchpoint.
    })
  );
  const emailProvider = authProviders[authProviders.length - 1];
  if (emailProvider && "sendVerificationRequest" in emailProvider) {
    // Resend ignores a callback supplied in its options, so replace the
    // returned provider method that Auth.js actually invokes.
    emailProvider.sendVerificationRequest = createPlatformVerificationEmailSender();
  }
}

export const authConfig = {
  pages: {
    signIn: "/signup",
    verifyRequest: "/login",
  },
  session: {
    strategy: "jwt",
  },
  providers: authProviders,
  callbacks: {
    authorized: (params) => {
      if (!params || !params.request) {
        return true;
      }

      return true;
    },
    jwt: async ({ token, user, account }) => {
      try {
        if (user) {
          console.log("[auth][jwt] user present in token, sub:", token.sub);
          token.orgId = (user as { orgId?: string }).orgId;
          token.role = (user as { role?: string }).role;
        }

        if (token.sub) {
          let [dbUser] = await db
            .select({
              id: users.id,
              orgId: users.orgId,
              role: users.role,
              planId: users.planId,
              subscriptionStatus: users.subscriptionStatus,
              billingPeriod: users.billingPeriod,
              trialEndsAt: users.trialEndsAt,
            })
            .from(users)
            .where(eq(users.id, token.sub))
            .limit(1);

          // v1.19 — self-healing JWT recovery. Why this exists:
          //
          //   The session strategy is JWT, so token.sub is what the page
          //   queries with. But token.sub can drift away from the real
          //   users.id row in three ways:
          //     1. createUser failed mid-flow (org created, users INSERT
          //        threw — user has a JWT but no users row)
          //     2. JWT was minted from a user that was later deleted +
          //        recreated with a new uuid (re-claim flows, manual
          //        ops cleanup)
          //     3. Cross-deployment JWT carry-over (rare in practice)
          //
          //   Without recovery: every page hits the v1.7.3 synthesized-
          //   empty-record path, dashboard renders an empty shell with
          //   no workspace, no plan, no surface for the user to take
          //   any meaningful action. They look "signed in" but every
          //   write 403s.
          //
          //   v1.19 fix: when token.sub doesn't resolve, fall back to
          //   email. If a users row with this email exists, re-anchor
          //   token.sub to that row's id silently. Log it so we can
          //   detect and root-cause the original drift in production.
          if (!dbUser && typeof token.email === "string" && token.email.length > 0) {
            const normalizedEmail = token.email.trim().toLowerCase();
            const [recovered] = await db
              .select({
                id: users.id,
                orgId: users.orgId,
                role: users.role,
                planId: users.planId,
                subscriptionStatus: users.subscriptionStatus,
                billingPeriod: users.billingPeriod,
                trialEndsAt: users.trialEndsAt,
              })
              .from(users)
              .where(eq(users.email, normalizedEmail))
              .limit(1);
            if (recovered) {
              console.warn(
                `[auth][jwt] self_healed_token_sub: token.sub=${token.sub} did not resolve, recovered via email=${normalizedEmail.split("@")[1] ?? "(?)"} user_id=${recovered.id}`,
              );
              token.sub = recovered.id;
              dbUser = recovered;
            } else {
              console.warn(
                `[auth][jwt] orphan_token_no_email_match: token.sub=${token.sub} email_domain=${normalizedEmail.split("@")[1] ?? "(?)"} — user has a JWT but no users row by id OR email`,
              );
            }
          }

          if (dbUser) {
            token.orgId = dbUser.orgId;
            token.role = dbUser.role;
            token.planId = dbUser.planId ?? null;
            token.subscriptionStatus = normalizeBillingStatus(dbUser.subscriptionStatus);
            token.billingPeriod = normalizeBillingPeriod(dbUser.billingPeriod);
            token.trialEndsAt = dbUser.trialEndsAt ? dbUser.trialEndsAt.toISOString() : null;

            const [org] = await db
              .select({ id: organizations.id, soulCompletedAt: organizations.soulCompletedAt, integrations: organizations.integrations, settings: organizations.settings })
              .from(organizations)
              .where(eq(organizations.id, dbUser.orgId))
              .limit(1);
            token.soulCompleted = Boolean(org?.soulCompletedAt);
            token.welcomeShown = Boolean((org?.settings as Record<string, unknown> | undefined)?.welcomeShown);

            if (account?.provider === "google" && org) {
              const [googleAccount] = await db
                .select({
                  accessToken: accounts.accessToken,
                  refreshToken: accounts.refreshToken,
                  expiresAt: accounts.expiresAt,
                  scope: accounts.scope,
                })
                .from(accounts)
                .where(and(eq(accounts.userId, dbUser.id), eq(accounts.provider, "google")))
                .limit(1);

              if (googleAccount) {
                const existingIntegrations = (org.integrations ?? {}) as Record<string, unknown>;
                const existingGoogle = (existingIntegrations.google ?? {}) as Record<string, unknown>;
                const hasCalendarScope = Boolean(googleAccount.scope?.includes("https://www.googleapis.com/auth/calendar"));

                const nextGoogle = {
                  ...existingGoogle,
                  calendarConnected: hasCalendarScope || Boolean(existingGoogle.calendarConnected),
                  connected: hasCalendarScope || Boolean(existingGoogle.connected),
                  accessToken: googleAccount.accessToken ?? String(existingGoogle.accessToken ?? ""),
                  refreshToken: googleAccount.refreshToken ?? String(existingGoogle.refreshToken ?? ""),
                  expiresAt: googleAccount.expiresAt ?? Number(existingGoogle.expiresAt ?? 0),
                  scope: googleAccount.scope ?? String(existingGoogle.scope ?? ""),
                };

                await db
                  .update(organizations)
                  .set({
                    integrations: {
                      ...existingIntegrations,
                      google: nextGoogle,
                    },
                    updatedAt: new Date(),
                  })
                  .where(eq(organizations.id, org.id));
              }
            }
          }
        }

        return token;
      } catch (err) {
        console.error("[auth][jwt] callback FAILED:", err);
        throw err;
      }
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.orgId = (token.orgId as string | undefined) ?? "";
        session.user.role = (token.role as string | undefined) ?? "member";
        session.user.soulCompleted = Boolean(token.soulCompleted);
        session.user.welcomeShown = Boolean(token.welcomeShown);
        session.user.planId = (token.planId as string | undefined) ?? null;
        session.user.subscriptionStatus =
          (token.subscriptionStatus as "trialing" | "active" | "past_due" | "canceled" | "unpaid" | undefined) ?? "trialing";
        session.user.billingPeriod = (token.billingPeriod as "monthly" | "yearly" | undefined) ?? "monthly";
        session.user.trialEndsAt = (token.trialEndsAt as string | undefined) ?? null;
      }

      return session;
    },
  },
  events: {
    // 2026-05-26 — ops notification on every new signup. NextAuth fires
    // events.createUser exactly once after the adapter's createUser
    // returns (post-INSERT into the users table), so this can't double-
    // fire on a sign-in by an existing user. The signup helper is
    // wrapped in its own try/catch and never throws, but we add a
    // belt-and-suspenders try here too — auth must not break if the
    // helper somehow regresses.
    //
    // The `source` field is best-effort. NextAuth's events.createUser
    // signature exposes only the created user object, not request
    // context (cookies, redirectTo). Plumbing those would require
    // jumping through the signIn callback to stash them on the JWT
    // and reading back here, which adds surface area we don't need
    // for v1. The recipient still sees the email — that's enough.
    createUser: async ({ user }) => {
      try {
        const email = typeof user.email === "string" ? user.email : "";
        const userId = typeof user.id === "string" ? user.id : "";
        if (!email || !userId) {
          // Defensive — the adapter always produces both, but if a
          // future provider doesn't we'd rather skip the alert than
          // send a half-formed one.
          return;
        }
        await sendNewSignupAlert({
          email,
          userId,
          createdAt: new Date(),
          source: null,
        });
      } catch (err) {
        console.warn(
          `[auth][events.createUser] sendNewSignupAlert threw (swallowed): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2026-08-06 funnel observability — signed_up person-funnel event.
      // Never let a capture failure affect signup: captureFunnelEvent is
      // itself fire-and-forget/catch-swallowing, but events.createUser's
      // own signature has no provider/account context to cheaply derive
      // `method`, so it's omitted here (builder treats it as optional).
      // orgId comes from the adapter's createUser `returning` (auth.ts) —
      // NextAuth passes the adapter's return value through as `user`.
      try {
        const orgId = typeof (user as { orgId?: unknown }).orgId === "string" ? (user as { orgId: string }).orgId : null;
        const userId = typeof user.id === "string" ? user.id : null;
        const email = typeof user.email === "string" ? user.email : null;

        // 2026-08-23 — first-touch attribution. posthog-js persists the
        // anonymous distinct id + first-touch URL/referrer in a cookie on
        // .seldonframe.com; reading it here lets signed_up carry
        // $initial_utm_* server-side AND stitches the anonymous browser
        // person to the new user without depending on the user surviving
        // to a bridge-mounted page (the Aug-22 surge was 81% direct and
        // unattributable partly because of this gap). Best-effort: the
        // inner try means a cookie-read failure (e.g. outside a request
        // scope) silently degrades to the pre-2026-08-23 behavior.
        let attribution: { initialUrl?: string | null; initialReferrer?: string | null; utm?: Record<string, string> } | null = null;
        let anonDistinctId: string | null = null;
        try {
          const { cookies } = await import("next/headers");
          const { posthogCookieName, parsePosthogCookieValue, extractUtmParams } = await import(
            "@/lib/analytics/signup-attribution"
          );
          const cookieName = posthogCookieName(process.env.NEXT_PUBLIC_POSTHOG_KEY);
          const raw = cookieName ? (await cookies()).get(cookieName)?.value : undefined;
          const info = parsePosthogCookieValue(raw);
          anonDistinctId = info.anonDistinctId;
          if (info.initialUrl || info.initialReferrer) {
            attribution = {
              initialUrl: info.initialUrl,
              initialReferrer: info.initialReferrer,
              utm: extractUtmParams(info.initialUrl),
            };
          }
        } catch {
          // Attribution is enrichment only — signup capture proceeds bare.
        }

        const { buildSignedUpEvent, captureFunnelEvent, aliasAnonToUser } = await import("@/lib/analytics/funnel");
        captureFunnelEvent(buildSignedUpEvent({ userId, orgId, email, attribution }));
        aliasAnonToUser(userId, anonDistinctId);
      } catch (err) {
        console.warn(
          `[auth][events.createUser] signed_up capture threw (swallowed): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  },
} satisfies NextAuthConfig;
