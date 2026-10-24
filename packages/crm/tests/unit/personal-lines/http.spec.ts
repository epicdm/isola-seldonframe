import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPersonalLineDetailHandler, createPersonalLinesListHandler } from "../../../src/lib/personal-lines/http";

const ownedLine = {
  referenceId: "contact-a",
  accountAssigned: true,
  customerId: "contact-a",
  customerName: "Customer A",
  stage: "Line created",
  facts: { did_masked: "+1 767 *** 1001" },
  serviceEvidence: { status: "unavailable" as const },
  updatedAt: "2026-10-24T10:00:00.000Z",
};

describe("Personal Lines HTTP tenant boundary", () => {
  test("list/search ignore caller-supplied workspace ids and use only server auth context", async () => {
    const calls: Array<[string, string]> = [];
    const handler = createPersonalLinesListHandler(
      async () => "workspace-a",
      async (workspaceId, search) => {
        calls.push([workspaceId, search]);
        return workspaceId === "workspace-a" && search === "1001" ? [ownedLine] : [];
      },
    );

    const response = await handler(new Request("https://app.test/api/personal-lines?search=1001&orgId=workspace-b"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { lines: [ownedLine] });
    assert.deepEqual(calls, [["workspace-a", "1001"]]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });

  test("unauthenticated list requests never reach the data reader", async () => {
    let read = false;
    const handler = createPersonalLinesListHandler(async () => null, async () => {
      read = true;
      return [ownedLine];
    });
    const response = await handler(new Request("https://app.test/api/personal-lines?orgId=workspace-a"));
    assert.equal(response.status, 401);
    assert.equal(read, false);
  });

  test("detail uses the server workspace and hides foreign resources as not found", async () => {
    const calls: Array<[string, string]> = [];
    const handler = createPersonalLineDetailHandler(async () => "workspace-b", async (workspaceId, subjectId) => {
      calls.push([workspaceId, subjectId]);
      return null;
    });
    const response = await handler(new Request("https://app.test/api/personal-lines/contact-a?orgId=workspace-a"), "contact-a");
    assert.equal(response.status, 404);
    assert.deepEqual(calls, [["workspace-b", "contact-a"]]);
  });

  test("unauthenticated detail requests never reach the data reader", async () => {
    let read = false;
    const handler = createPersonalLineDetailHandler(async () => null, async () => {
      read = true;
      return ownedLine;
    });
    const response = await handler(new Request("https://app.test/api/personal-lines/contact-a"), "contact-a");
    assert.equal(response.status, 401);
    assert.equal(read, false);
  });
});
