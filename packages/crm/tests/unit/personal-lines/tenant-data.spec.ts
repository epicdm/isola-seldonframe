import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTenantPersonalLineReader, type SubjectFactsRow } from "../../../src/lib/personal-lines/tenant-data";

function row(orgId: string, subject: string, account: string | null, did: string): SubjectFactsRow {
  return {
    orgId,
    provider: "personal_line",
    externalId: subject,
    lastVersion: 3,
    facts: {
      pl_account_id: account,
      did_masked: did,
      registered_at: "2026-10-24T10:00:00.000Z",
      payment_state: "paid",
      balance: "999.00",
    },
    projectedDealId: null,
    projectedDealCreatedAt: null,
    updatedAt: new Date("2026-10-24T10:00:00.000Z"),
    customerId: `contact-${subject.replace("subject-", "")}`,
    customerName: `Customer ${subject.replace("subject-", "")}`,
    serviceAccountId: account,
    serviceTenantKey: account ? (orgId.endsWith("2") ? "other" : "epic") : null,
  };
}

describe("tenant Personal Line read model", () => {
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const rows = [row(a, "subject-a", "account-a", "+1 767 *** 1001"), row(b, "subject-b", "account-b", "+1 767 *** 2002")];
  const reader = createTenantPersonalLineReader(async (orgId, contactId) =>
    rows.filter((item) => item.orgId === orgId && (!contactId || item.customerId === contactId)),
  );

  test("lists and searches only rows returned for the active tenant", async () => {
    assert.deepEqual((await reader.list(a)).map((line) => line.accountAssigned), [true]);
    assert.deepEqual((await reader.list(a, "2002")).map((line) => line.accountAssigned), []);
    assert.deepEqual((await reader.list(a, "1001")).map((line) => line.accountAssigned), [true]);
    assert.equal((await reader.list(a, "customer a")).length, 1);
  });

  test("search includes tenant associations beyond the former 500-row cap", async () => {
    const manyRows = Array.from({ length: 601 }, (_, index) =>
      row(a, `subject-${index}`, `account-${index}`, `+1 767 *** ${String(index).padStart(4, "0")}`),
    );
    const allRowsReader = createTenantPersonalLineReader(async (orgId) =>
      orgId === a ? manyRows : [],
    );

    assert.equal((await allRowsReader.list(a)).length, 601);
    assert.deepEqual((await allRowsReader.list(a, "600")).map((line) => line.accountAssigned), [true]);
  });

  test("a foreign subject is not readable by detail lookup", async () => {
    assert.equal(await reader.get(a, "contact-b"), null);
  });

  test("projects only approved lifecycle facts and never treats billing fields as evidence", async () => {
    const line = await reader.get(a, "contact-a");
    assert.equal(line?.stage, "App activated");
    assert.equal(line?.referenceId, "contact-a");
    assert.equal(line?.accountAssigned, true);
    assert.equal(line?.customerName, "Customer a");
    assert.equal(line?.facts.registered_at, "2026-10-24T10:00:00.000Z");
    assert.equal("balance" in (line?.facts ?? {}), false);
    assert.equal(JSON.stringify(line).includes("account-a"), false);
    assert.equal(JSON.stringify(line).includes("subject-a"), false);
    assert.equal("payment_state" in (line?.facts ?? {}), false);
  });

  test("shows a trusted signup before the service account ID is assigned", async () => {
    const noAccount = { ...row(a, "subject-pending", null, ""), lastVersion: 1, facts: { door: "uplink" } };
    const pendingReader = createTenantPersonalLineReader(async () => [noAccount]);
    const [pending] = await pendingReader.list(a);
    assert.equal(pending.accountAssigned, false);
    assert.equal(pending.stage, "Signup started");
    assert.equal((await pendingReader.get(a, "contact-pending"))?.stage, "Signup started");
    assert.equal((await pendingReader.list(a, "customer pending")).length, 1);
  });

  test("fetches live service evidence only after a tenant-scoped detail row resolves", async () => {
    const calls: string[] = [];
    const detailReader = createTenantPersonalLineReader(
      async (orgId, contactId) => rows.filter((item) => item.orgId === orgId && (!contactId || item.customerId === contactId)),
      async (orgId, tenantKey, accountId) => {
        calls.push(`${orgId}:${tenantKey}:${accountId}`);
        return { status: "association_mismatch" };
      },
    );

    await detailReader.list(a);
    assert.deepEqual(calls, []);
    assert.equal(await detailReader.get(b, "contact-a"), null);
    assert.deepEqual(calls, []);
    const line = await detailReader.get(a, "contact-a");
    assert.deepEqual(calls, [`${a}:epic:account-a`]);
    assert.deepEqual(line?.serviceEvidence, { status: "association_mismatch" });
  });

  test("does not read service data from an account id unless the signed association exists", async () => {
    const calls: string[] = [];
    const unverified = { ...row(a, "subject-unverified", "account-unverified", "+1 767 *** 3003"), serviceAccountId: null, serviceTenantKey: null };
    const reader = createTenantPersonalLineReader(async () => [unverified], async (...args) => {
      calls.push(args.join(":"));
      return { status: "unavailable" };
    });
    const line = await reader.get(a, "contact-unverified");
    assert.equal(line?.serviceAssociationStatus, "unverified");
    assert.equal(line?.accountAssigned, false);
    assert.deepEqual(calls, []);
  });
});
