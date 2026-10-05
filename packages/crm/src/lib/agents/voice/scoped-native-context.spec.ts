import assert from "node:assert/strict";
import test from "node:test";
import { authorizeVoiceContext } from "./scoped-native-context";

const pat = {
  workspaceId: "738f1181-b540-48c3-b72f-d63f92463755",
  agentSlug: "pat-demo-household-9d5e--default",
};
const quinn = {
  workspaceId: "476d8685-74a7-4539-a8f6-7778dea6a1eb",
  agentSlug: "quinn-demo-household--default",
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

test("cross-wired workspace and agent pairs fail closed", () => {
  assert.deepEqual(authorize({ ...pat, agentSlug: quinn.agentSlug }), {
    ok: false,
    status: 404,
  });
  assert.deepEqual(authorize({ ...quinn, agentSlug: pat.agentSlug }), {
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
