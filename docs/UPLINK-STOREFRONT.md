# Uplink platform storefront (root page of a branded host)

EPIC modification notice (AGPL-3.0 section 5(a)), 2026-10-12. Files: `packages/crm/src/app/(public)/page.tsx`,
`packages/crm/src/components/branding/platform-storefront.tsx`, `packages/crm/src/lib/branding/storefront.ts`,
`packages/crm/tests/unit/branding/platform-storefront.spec.tsx`.

## What it is

When `PLATFORM_NAME` is not `SeldonFrame`, `/` renders the storefront: three entry points built from the existing
SeldonFrame design tokens and primitives (Card, buttonVariants), no new visual language.

1. Personal Line (free trial, outgoing calling only).
2. Business services (managed, by enquiry).
3. Workspace sign-in (`<PLATFORM_APP_URL>/login`).

The upstream SeldonFrame marketing landing (`UnifiedLanding`) is untouched and still serves a default
(`PLATFORM_NAME` unset or `SeldonFrame`) install. The footer keeps the `/license` open-source notices link and
shows a source link when `PLATFORM_SOURCE_URL` is set.

## The signup switch (outage mode)

| Setting | Value | Result |
|---|---|---|
| `PLATFORM_PERSONAL_LINE_SIGNUP` | `open` (exact, case-insensitive) | Real CTA "Start your free trial" linking to the Personal Line workspace page |
| same | unset, empty, `paused`, anything else | No link. A status box says sign-up is temporarily unavailable, gives no date, and offers a mailto to `PLATFORM_SUPPORT_EMAIL` |
| `PLATFORM_PERSONAL_LINE_URL` | optional https URL | Overrides the CTA target. Default `https://uplinks-workspace-4816.uplink.epic.dm`. Non-https or credentialed values are ignored |

Default is fail-closed: shipping this change leaves sign-up shown as unavailable until someone sets the value.
It is read per request, so restoring is: set `PLATFORM_PERSONAL_LINE_SIGNUP=open` in the EasyPanel application
service environment and restart/redeploy the service by digest (no rebuild, no code change). Do this only after the
customer path (WhatsApp reply path and Personal Line service) has passed its external proof. To go back to outage
mode: remove the value or set `paused` and restart.

## Claim to source table (do not add a claim without adding its source)

| Claim on the page | Port source |
|---|---|
| Your own +1 767 Dominica number for making voice calls from the free Cloud Softphone app (iPhone, Android) | `pl-launch-readiness-for-sales-marketing-2026-10-10` (approved claims, how it works) |
| Free 7-day trial with 60 Dominica minutes, EC$0 | same record; `dec-owner-pl-launch-ladder-included-minutes-2026-09-27` |
| The launch offer covers outgoing calling | `pl-launch-readiness-for-sales-marketing-2026-10-10` (offer sentence) |
| Voice only: no SMS and no emergency calling | same record (approved claims); offer records exclusions |
| Open-mode helper: sign up and get guidance in WhatsApp, then install the free app | same record (HOW IT WORKS) |
| Business: internet and telephone service run by EPIC | `dec-owner-uplink-isp-ai-front-office-agency-platform-positioning-2026-10-06`; the previous root page copy |
| Business: set up with a person, not self-service; availability confirmed first | `offer-epic-smart-business-line` and `offer-epic-ai-upgrade-existing-line` exclusions ("No self-service signup"); previous root copy ("confirm service availability and setup") |
| Workspace sign-in by emailed link | `ev-lane-a-uplink-v425-owner-signin-result-timezone-on-wrong-workspace-and-branding-scope-2026-10-07` (native magic link via SMTP2GO) |

Deliberately NOT claimed: incoming calls, payments or top-ups (Fiserv), prices beyond the trial, "unlimited",
the WhatsApp AI receptionist and shared inbox (offers exist but the Chatwoot path is not serving; add them only when
that path is restored and accepted), voice AI, any date.

The test `platform-storefront.spec.tsx` fails if the page contains `coming soon`, `incoming`, `fiserv`, `unlimited`,
`seldonframe`, `voice ai`, or `stay tuned`, and carries a control proving the pattern fires.

## Why the upstream landing page is not the base (section by section)

The upstream landing (`UnifiedLanding`, still intact for a default install) is a sales page for SeldonFrame's agency
product ("Sell AI front offices. Deploy them in minutes."). The v4.33 P1 defect was its CONTENT on the Uplink host, not
its design, so this storefront keeps the DESIGN (the `.lp-root` parchment tokens, deep-green CTA and closing slab,
display serif headlines, mono eyebrows, bordered cards, Hanken/Newsreader fonts) and replaces the content.

| Upstream section | Verdict for Uplink |
|---|---|
| Nav (Log in, Start for free, For agencies, Docs, Pricing) | Chrome pattern kept (logo left, one action right). Links dropped: `/agencies`, `/docs`, `/pricing-public` are hidden (404) on a branded host; "Start for free" enters the vendor URL builder |
| Hero ("Sell AI front offices", paste-a-URL builder, demo marquee) | Not usable: vendor pitch; the builder runs unauthenticated generation Uplink does not offer (P2 defect on generate-landing-page) |
| IDE strip (Claude, Cursor, Windsurf install) | Not usable: links `/build#install`, not an Uplink offer |
| Agent orbit (integrations) | Not usable: integration claims not backed by Port |
| Build steps (describe it / record it) | Not usable: `/record` builder flow, not offered |
| Agency ownership + math ("Own everything", GoHighLevel price comparison, 0% GMV) | Not usable: vendor pricing and comparative claims; links `/pricing` (hidden) |
| Modules and Agents (CRM, booking, intake, receptionist that books, missed-call text-back, review requester) | Not usable: missed-call recovery and voice receptionist are explicitly NOT OFFERED in Port (offer-missed-call-recovery-not-offered) |
| Pricing section | Not usable: vendor tiers and GMV fees |
| Proof strip, FAQ | Not usable: vendor claims; the FAQ ACCORDION pattern could be reused later with Port-backed Q&A |
| Final CTA slab | Pattern kept (deep-green closing slab) with our contact route |
| Footer | Pattern kept (alternate-band footer); vendor links dropped, `/license` notices kept |

## Public edge (why a non-admin address got 403)

The root is blocked at the EASYPANEL/TRAEFIK edge, not by app code: the app host carries the `uplink-operators`
ipAllowList middleware, so a non-allow-listed address gets a plain 403 "Forbidden" for `/`, `/login`, `/api/*` and
`/_next/static/*`, while `/license`, the embed/turn routes and the workspace host are separate public domain entries
(ev-lane-a-uplink-personal-line-public-pilot-OPENED-2026-10-08). `docs/ops/uplink-storefront-edge.traefik.yaml` is the
minimal exception (exact `/` plus static assets only, a Traefik file-provider router because an EasyPanel domain path is
a prefix and `/` would open everything). Locked by `storefront-edge.spec.ts` (positive control + protected-route matrix).
Apply it only in the executor's window, after the app is built and deployed; it is NOT applied by this change.
