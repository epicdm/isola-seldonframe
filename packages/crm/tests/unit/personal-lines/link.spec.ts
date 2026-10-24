import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { linkPersonalLine, type LinkStore } from "../../../src/lib/personal-line/link";

class MemoryLinkStore implements LinkStore {
  contacts = new Map<string, { phone: string | null; source: string }>();
  identities = new Map<string, { contactId: string }>();
  private key(orgId: string, provider: string, externalId: string) {
    return `${orgId}:${provider}:${externalId}`;
  }
  async findIdentityByExternal(orgId: string, provider: string, externalId: string) {
    return this.identities.get(this.key(orgId, provider, externalId)) ?? null;
  }
  async contactExists(orgId: string, contactId: string) {
    return this.contacts.has(`${orgId}:${contactId}`);
  }
  async setContactPhone(orgId: string, contactId: string, phone: string) {
    const contact = this.contacts.get(`${orgId}:${contactId}`);
    if (contact && contact.phone === null) contact.phone = phone;
  }
  async createContact(orgId: string, contact: { id: string; firstName: string; phone: string | null; source: string }) {
    this.contacts.set(`${orgId}:${contact.id}`, { phone: contact.phone, source: contact.source });
  }
  async insertIdentity(orgId: string, provider: string, externalId: string, contactId: string) {
    const key = this.key(orgId, provider, externalId);
    if (this.identities.has(key)) return false;
    this.identities.set(key, { contactId });
    return true;
  }
}

describe("Personal Line external identity association", () => {
  test("concurrent first events converge on one workspace-local contact and one identity", async () => {
    const store = new MemoryLinkStore();
    const input = { subjectId: "pl-subject-1", waId: "17675550123", displayName: "Subscriber" };
    const [first, second] = await Promise.all([
      linkPersonalLine("workspace-a", input, store),
      linkPersonalLine("workspace-a", input, store),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.contactId, second.contactId);
    assert.deepEqual([first.created, second.created].sort(), [false, true]);
    assert.equal(store.contacts.size, 1);
    assert.equal(store.identities.size, 1);
  });

  test("replay reuses the association and does not adopt an operator-entered phone", async () => {
    const store = new MemoryLinkStore();
    const input = { subjectId: "pl-subject-2", waId: "17675550123", displayName: "Subscriber" };
    const created = await linkPersonalLine("workspace-a", input, store);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    store.contacts.get(`workspace-a:${created.contactId}`)!.phone = "+17679990000";

    const replay = await linkPersonalLine("workspace-a", input, store);
    assert.deepEqual(replay, { ok: true, contactId: created.contactId, created: false });
    assert.equal(store.contacts.get(`workspace-a:${created.contactId}`)?.phone, "+17679990000");
    assert.equal(store.contacts.size, 1);
    assert.equal(store.identities.size, 1);
  });

  test("the same upstream subject is isolated into distinct workspace identities", async () => {
    const store = new MemoryLinkStore();
    const input = { subjectId: "pl-subject-3", waId: null, displayName: null };
    const a = await linkPersonalLine("workspace-a", input, store);
    const b = await linkPersonalLine("workspace-b", input, store);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.contactId, b.contactId);
    assert.equal(store.contacts.size, 2);
    assert.equal(store.identities.size, 2);
  });
});
