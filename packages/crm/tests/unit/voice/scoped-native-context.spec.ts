import assert from "node:assert/strict";
import test from "node:test";
import { authorizeVoiceContext } from "../../../src/lib/agents/voice/scoped-native-context";

const pat = {
  workspaceId: "738f1181-b540-48c3-b72f-d63f92463755",
  agentSlug: "default",
};
const quinn = {
  workspaceId: "476d8685-74a7-4539-a8f6-7778dea6a1eb",
  agentSlug: "default",
};
const env = {
  secret: "synthetic-service-secret",
  allowlistJson: JSON.stringify({
    [pat.workspaceId]: pat.agentSlug,
    [quinn.workspaceId]: quinn.agentSlug,
  }),
};

function authorize(
  binding: typeof pat,
  overrides: Record<string, unknown> = {},
) {
  return authorizeVoiceContext({
    authorization: "Bearer synthetic-service-secret",
    body: binding,
    ...env,
    ...overrides,
  });
}

test("Pat and Quinn each resolve only their own native workspace and agent", () => {
  assert.deepEqual(authorize(pat), { ok: true, binding: pat });
  assert.deepEqual(authorize(quinn), { ok: true, binding: quinn });
});

test("cross-wired or unlisted workspace and agent pairs fail closed", () => {
  // Both customers use the database slug "default", so the workspace id is the isolation boundary:
  // a listed workspace with any slug other than its allowlisted one is refused...
  assert.deepEqual(authorize({ ...pat, agentSlug: "voice-receptionist" }), {
    ok: false,
    status: 404,
  });
  assert.deepEqual(authorize({ ...quinn, agentSlug: "voice-receptionist" }), {
    ok: false,
    status: 404,
  });
  // ...and a workspace that is not on the allowlist is refused even with the valid slug (the EPIC workspace here).
  assert.deepEqual(
    authorize({ workspaceId: "9e0c646b-de4a-4707-946c-838ebbf6607b", agentSlug: "default" }),
    { ok: false, status: 404 },
  );
});

test("the public id form <org>--<agent> is not a database slug and is refused", () => {
  assert.deepEqual(authorize({ ...pat, agentSlug: "pat-demo-household-9d5e--default" }), {
    ok: false,
    status: 404,
  });
  assert.deepEqual(authorize({ ...quinn, agentSlug: "quinn-demo-household--default" }), {
    ok: false,
    status: 404,
  });
});

test("missing or incorrect service credentials are rejected", () => {
  assert.deepEqual(authorize(pat, { authorization: null }), {
    ok: false,
    status: 401,
  });
  assert.deepEqual(authorize(pat, { authorization: "Bearer wrong" }), {
    ok: false,
    status: 401,
  });
});

test("missing or malformed server allowlist is unavailable, not permissive", () => {
  assert.deepEqual(authorize(pat, { allowlistJson: undefined }), {
    ok: false,
    status: 503,
  });
  assert.deepEqual(authorize(pat, { allowlistJson: "[]" }), {
    ok: false,
    status: 503,
  });
});

test("malformed request identifiers never resolve", () => {
  assert.deepEqual(authorize({ ...pat, workspaceId: "not-a-uuid" }), {
    ok: false,
    status: 404,
  });
});
