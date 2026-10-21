// Path test (Law 20) for Composio session toolkit drift through the REAL
// createConnectLink -> ensureSession path. A session cached before a toolkit was
// added to the catalog (e.g. googledocs) must NOT be reused to authorize it.
// Only lib/secrets is module-mocked (DB seam); the Composio client is injected
// via the existing opts.client seam.
//
// Needs: node --experimental-test-module-mocks --import tsx --test <this file>

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, describe, mock, test } from "node:test";

const crm = path.resolve(__dirname, "../..");
const OLD_TOOLKITS = [
  "gmail", "googlecalendar", "googledrive", "slack",
  "notion", "hubspot", "quickbooks", "outlook",
];

type Rec = { created: string[][]; authorizedOn: string[]; stored: string[] };

function fakeClient(rec: Rec, cachedToolkits: string[]) {
  const sessions = new Map<string, string[]>([["cached-1", cachedToolkits]]);
  const sessionObj = (id: string) => ({
    sessionId: id,
    mcp: { url: `https://mcp.example/${id}`, headers: {} },
    toolkits: async () => ({ items: (sessions.get(id) ?? []).map((slug) => ({ slug, name: slug })) }),
    authorize: async (toolkit: string) => {
      rec.authorizedOn.push(`${id}:${toolkit}`);
      return { redirectUrl: `https://consent.example/${toolkit}` };
    },
  });
  return {
    use: async (id: string) => {
      if (!sessions.has(id)) throw new Error("404 session");
      return sessionObj(id);
    },
    create: async (_user: string, cfg: { toolkits: string[] }) => {
      rec.created.push([...cfg.toolkits]);
      sessions.set("new-1", [...cfg.toolkits]);
      return sessionObj("new-1");
    },
  };
}

let createConnectLink: typeof import("../../src/lib/integrations/composio/client").createConnectLink;
let rec: Rec;

before(async () => {
  mock.module(pathToFileURL(path.join(crm, "src/lib/secrets.ts")).href, {
    namedExports: {
      getSecretValue: async () => "cached-1",
      storeSecret: async ({ value }: { value: string }) => {
        rec.stored.push(value);
      },
    },
  });
  ({ createConnectLink } = await import("../../src/lib/integrations/composio/client"));
});

describe("createConnectLink: cached session toolkit drift", () => {
  test("a cached session lacking googledocs is replaced; consent runs on a session that includes it", async () => {
    rec = { created: [], authorizedOn: [], stored: [] };
    const client = fakeClient(rec, OLD_TOOLKITS);
    const out = await createConnectLink("org-1", "googledocs", "https://cb.example", {
      client: client as never,
      actorUserId: "user-1",
    });
    assert.equal(out.redirectUrl, "https://consent.example/googledocs");
    assert.equal(rec.created.length, 1, "a new session was created");
    assert.ok(rec.created[0].includes("googledocs"));
    assert.deepEqual(rec.authorizedOn, ["new-1:googledocs"]);
    assert.deepEqual(rec.stored, ["new-1"], "the new session id is cached");
  });

  test("control: a cached session that already covers the catalog is reused (no recreate)", async () => {
    rec = { created: [], authorizedOn: [], stored: [] };
    const client = fakeClient(rec, [...OLD_TOOLKITS, "googledocs"]);
    const out = await createConnectLink("org-1", "gmail", "https://cb.example", {
      client: client as never,
      actorUserId: "user-1",
    });
    assert.equal(out.redirectUrl, "https://consent.example/gmail");
    assert.equal(rec.created.length, 0);
    assert.deepEqual(rec.authorizedOn, ["cached-1:gmail"]);
  });
});
