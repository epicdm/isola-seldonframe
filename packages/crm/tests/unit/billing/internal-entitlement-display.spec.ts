// EPIC 2026-10-20 — billing display for an internal (payment-off) entitlement: pure rules (no database).
// The database reader is proven in tests/integration/billing-internal-entitlement.spec.ts; the page wiring by the source checks below.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  billingPresentation,
  hasStripeLink,
  isInternalEntitlementInEffect,
  portalCustomerExists,
  type InternalEntitlementRecord,
} from "../../../src/lib/billing/internal-entitlement";
import type { OrganizationSubscription } from "../../../src/db/schema";

const RECORD: InternalEntitlementRecord = { actionId: "da988b35-0421-4551-8bdb-635494950cfb", tier: "growth", paymentCollection: "off" };
const INTERNAL: OrganizationSubscription = { tier: "growth", status: "active" };
const PAID: OrganizationSubscription = { tier: "workspace", status: "active", stripeCustomerId: "cus_fixture", stripeSubscriptionId: "sub_fixture", stripePriceId: "price_fixture_month" };

const present = (o: Partial<Parameters<typeof billingPresentation>[0]> = {}) =>
  billingPresentation({ subscription: INTERNAL, record: RECORD, tier: "workspace", isGuestAdminToken: false, hasStripeCustomer: false, ...o });

describe("internal entitlement in effect", () => {
  test("EPIC's shape: active growth, no Stripe link, audited payment-off record", () => {
    assert.equal(isInternalEntitlementInEffect(INTERNAL, RECORD), true);
  });
  test("a legacy tier name and its normalised form are the same plan (growth == workspace)", () => {
    assert.equal(isInternalEntitlementInEffect({ tier: "workspace", status: "active" }, RECORD), true);
  });
  for (const [label, sub, rec] of [
    ["no record (never entitled, or reverted)", INTERNAL, null],
    ["record without payment-off", INTERNAL, { ...RECORD, paymentCollection: null }],
    ["record says payment on", INTERNAL, { ...RECORD, paymentCollection: "on" }],
    ["subscription gained a Stripe customer later", { ...INTERNAL, stripeCustomerId: "cus_x" }, RECORD],
    ["subscription gained a Stripe subscription later", { ...INTERNAL, stripeSubscriptionId: "sub_x" }, RECORD],
    ["subscription gained a Stripe price later", { ...INTERNAL, stripePriceId: "price_x" }, RECORD],
    ["status no longer active", { ...INTERNAL, status: "canceled" as const }, RECORD],
    ["status missing", { tier: "growth" }, RECORD],
    ["tier changed since the record (drift)", { ...INTERNAL, tier: "agency" }, RECORD],
    ["tier gone", { status: "active" as const }, RECORD],
    ["a normal paid Stripe subscription", PAID, RECORD],
  ] as const) {
    test(`not internal: ${label}`, () => {
      assert.equal(isInternalEntitlementInEffect(sub as OrganizationSubscription, rec as InternalEntitlementRecord | null), false);
    });
  }
  test("hasStripeLink reads exactly the three Stripe ids", () => {
    assert.equal(hasStripeLink({}), false);
    assert.equal(hasStripeLink({ tier: "growth", status: "active", maxWorkspaces: 1 }), false);
    assert.equal(hasStripeLink({ stripePriceId: "p" }), true);
  });
});

describe("billing presentation", () => {
  test("internal plan, no Stripe customer: labelled internal, Manage subscription hidden", () => {
    assert.deepEqual(present(), { internalPlan: true, showManageSubscription: false });
  });
  test("paid customer with a Stripe customer: unchanged (not internal, Manage subscription shown)", () => {
    assert.deepEqual(present({ subscription: PAID, record: null, hasStripeCustomer: true }), { internalPlan: false, showManageSubscription: true });
  });
  test("paid tier whose Stripe customer is the user's own: Manage subscription shown", () => {
    assert.deepEqual(present({ subscription: { tier: "workspace", status: "active" }, record: null, hasStripeCustomer: true }), { internalPlan: false, showManageSubscription: true });
  });
  test("paid tier with no Stripe customer anywhere: Manage subscription hidden (it could only redirect)", () => {
    assert.equal(present({ record: null, hasStripeCustomer: false }).showManageSubscription, false);
  });
  test("inactive tier: never Manage subscription", () => {
    assert.equal(present({ tier: "inactive", hasStripeCustomer: true }).showManageSubscription, false);
  });
  test("guest admin token: never Manage subscription", () => {
    assert.equal(present({ isGuestAdminToken: true, hasStripeCustomer: true }).showManageSubscription, false);
  });
  test("control: the two outputs key on different inputs (internalPlan ignores hasStripeCustomer; showManage ignores the record)", () => {
    assert.equal(present({ hasStripeCustomer: true }).internalPlan, present({ hasStripeCustomer: false }).internalPlan);
    assert.equal(present({ record: null, hasStripeCustomer: true }).showManageSubscription, present({ hasStripeCustomer: true }).showManageSubscription);
    assert.notEqual(present({ hasStripeCustomer: true }).showManageSubscription, present({ hasStripeCustomer: false }).showManageSubscription);
    assert.notEqual(present({ record: null }).internalPlan, present().internalPlan);
  });
});

describe("portal customer, as createBillingPortalSessionAction selects it (Codex r1)", () => {
  test("owner-like caller: the workspace's customer counts", () => {
    assert.equal(portalCustomerExists({ workspaceCustomerId: "cus_ws", callerIsOwnerLike: true, callerCustomerId: null }), true);
  });
  test("invited member, workspace has a customer, member has none: no portal customer (button hidden)", () => {
    assert.equal(portalCustomerExists({ workspaceCustomerId: "cus_ws", callerIsOwnerLike: false, callerCustomerId: null }), false);
  });
  test("invited member with a personal customer: their own customer counts", () => {
    assert.equal(portalCustomerExists({ workspaceCustomerId: "cus_ws", callerIsOwnerLike: false, callerCustomerId: "cus_me" }), true);
  });
  test("no customer anywhere (EPIC's internal plan): none", () => {
    assert.equal(portalCustomerExists({ workspaceCustomerId: null, callerIsOwnerLike: true, callerCustomerId: null }), false);
  });
});

describe("billing page wiring (source)", () => {
  const page = readFileSync(path.resolve("src/app/(dashboard)/settings/billing/page.tsx"), "utf8");
  test("Manage subscription renders only behind presentation.showManageSubscription", () => {
    const form = page.indexOf("<form action={createBillingPortalSessionAction}>");
    assert.ok(form > 0);
    assert.match(page.slice(Math.max(0, form - 120), form), /presentation\.showManageSubscription \? \(\s*$/);
    assert.equal(page.split("createBillingPortalSessionAction}").length - 1, 1, "exactly one portal form");
  });
  test("the internal label replaces every amount-owed surface: plan caption, estimated monthly, footer, usage total", () => {
    assert.match(page, /const INTERNAL_PLAN_LABEL = "Internal plan — no payment collected";/);
    assert.match(page, /presentation\.internalPlan \? INTERNAL_PLAN_LABEL : tierDisplay\.caption/);
    assert.match(page, /presentation\.internalPlan \? "No payment collected" : formatMoney\(usage\.estimatedTotal\)/);
    assert.match(page, /\{presentation\.internalPlan \? \(\s*INTERNAL_PLAN_LABEL/);
    assert.match(page, /<UsageCard usage=\{usage\} internalPlan=\{presentation\.internalPlan\} \/>/);
  });
  test("the Stripe-customer check follows the portal action's owner-aware selection", () => {
    assert.match(page, /hasStripeCustomer: portalCustomerExists\(\{\s*workspaceCustomerId: subscription\.stripeCustomerId,\s*callerIsOwnerLike,\s*callerCustomerId: caller\?\.stripeCustomerId,/);
    assert.match(page, /await isWorkspaceOwnerLike\(activeOrgId as string, session\.user\.id\)/);
  });
  test("Upgrade is still offered only on the inactive tier (paid display preserved)", () => {
    assert.match(page, /!isGuestAdminToken && tier === "inactive" \? \(\s*<Link\s+href="\/pricing"/);
  });
});
