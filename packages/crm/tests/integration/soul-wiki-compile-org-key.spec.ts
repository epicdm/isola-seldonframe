// EPIC 2026-10-21 — Soul Knowledge compile resolves the WORKSPACE's model key (BYOK first, then the platform key, including the
// mounted-file provider and its model) and fails VISIBLY: a source it could not compile becomes 'failed' with a secret-free reason
// in metadata.compileError, never 'pending' forever. Drives the REAL ingest route and the REAL "Recompile All" route (wiki POST)
// through the REAL compile + getAIClient against a REAL Postgres (production driver). Only the model endpoint (global fetch) and the
// session (@/auth) are faked. Port ev-laneA-soul-knowledge-compile-org-key-fix-2026-10-21.
// Scratch database only; all fixtures synthetic; ids/emails unique to this spec (a7/b7 prefixes).
//
// Opt-in: refuses unless NEON_LOCAL_HOST is set AND TRANSFER_DB_TEST=scratch. Needs node --experimental-test-module-mocks.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before, describe, mock } from "node:test";

import { sql } from "drizzle-orm";

const enabled = process.env.TRANSFER_DB_TEST === "scratch" && !!process.env.NEON_LOCAL_HOST;

const U = (n: number) => `a7000000-0000-4000-8000-00000000000${n}`;
const O = (n: number) => `b7000000-0000-4000-8000-00000000000${n}`;
const BYOK_ORG = O(1), NOKEY_ORG = O(2), PLATFORM_ORG = O(3), BADKEY_ORG = O(4);
const BYOK_KEY = ["sk", "ant", "fixture", "byok", "workspace"].join("-");
const BAD_KEY = ["sk", "ant", "fixture", "rejected", "key"].join("-");
const PLATFORM_FILE_KEY = ["fixture", "platform", "file", "key"].join("-");
const PLATFORM_BASE_URL = "https://platform-model.fixture.test/anthropic";
const PLATFORM_MODEL = "fixture-platform-model";
const ARTICLE = "## Fixture article\n\nThe business offers synthetic fixture services to synthetic fixture clients, every weekday.";

type SeenCall = { host: string; apiKey: string | undefined; authorization: string | undefined; model: string | undefined };

describe("Soul Knowledge compile: workspace key + visible failure (scratch Postgres, real routes)", { skip: !enabled && "set TRANSFER_DB_TEST=scratch with a scratch database" }, () => {
  let db: typeof import("@/db").db;
  let ingestPOST: typeof import("@/app/api/v1/soul/ingest/route").POST;
  let wikiPOST: typeof import("@/app/api/v1/soul/wiki/route").POST;
  let incrementalCompile: typeof import("@/lib/soul-wiki/compile").incrementalCompile;
  let DEFAULT_SONNET_MODEL: string;
  let session: { user: { id: string; orgId: string } } | null = null;
  const calls: SeenCall[] = [];
  const realFetch = globalThis.fetch;
  let dir = "";

  const rows = async <T,>(q: ReturnType<typeof sql>) => {
    const r = await db.execute(q);
    return ((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) ?? []) as T[];
  };
  const sourcesOf = (org: string) =>
    rows<{ id: string; status: string; metadata: Record<string, unknown> }>(sql`select id::text, status, metadata from soul_sources where org_id = ${org}::uuid order by created_at`);
  const wikiCount = async (org: string) => Number((await rows<{ n: string }>(sql`select count(*)::text as n from soul_wiki where org_id = ${org}::uuid`))[0].n);
  // The routes fire compile and return; wait for the source to leave the state it was in.
  const settle = async (org: string, from: string[]) => {
    for (let i = 0; i < 150; i++) {
      const s = await sourcesOf(org);
      if (s.length > 0 && s.every((r) => !from.includes(r.status))) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    return sourcesOf(org);
  };
  const ingestAs = async (user: string, org: string, text: string) => {
    session = { user: { id: user, orgId: org } };
    const res = await ingestPOST(new Request("http://app.fixture.test/api/v1/soul/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text", text, title: "Fixture source" }),
    }));
    assert.equal(res.status, 200, "control: the ingest route accepted the source");
    return res;
  };
  const recompileAs = async (user: string, org: string) => {
    session = { user: { id: user, orgId: org } };
    const res = await wikiPOST();
    assert.equal(res.status, 200, "control: Recompile All was accepted");
  };

  before(async () => {
    delete process.env.ANTHROPIC_API_KEY; // the live service has none
    delete process.env.MODEL_API_KEY_FILE;
    delete process.env.MODEL_BASE_URL;
    delete process.env.MODEL_NAME;
    process.env.ENCRYPTION_KEY = ["fixture", "soul", "compile", "encryption"].join("-");
    process.env.AUTH_SECRET = ["fixture", "soul", "compile", "secret"].join("-");
    dir = await mkdtemp(path.join(tmpdir(), "soul-compile-"));

    // The model endpoint: record which host, key and model each call used; reject BAD_KEY like the provider does.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = JSON.parse((await request.text()) || "{}") as { model?: string };
      const apiKey = request.headers.get("x-api-key") ?? undefined;
      calls.push({ host: url.host, apiKey, authorization: request.headers.get("authorization") ?? undefined, model: body.model });
      if (apiKey === BAD_KEY) {
        return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${BAD_KEY}` } }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "msg_fixture", type: "message", role: "assistant", model: body.model ?? "fixture",
        content: [{ type: "text", text: ARTICLE }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const crm = path.resolve(".");
    mock.module(pathToFileURL(path.join(crm, "src/auth.ts")).href, {
      namedExports: { auth: async () => session, signIn: async () => undefined, signOut: async () => undefined, handlers: {} },
    });
    mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }), headers: async () => new Headers() } });

    ({ db } = await import("@/db"));
    ({ POST: ingestPOST } = await import("@/app/api/v1/soul/ingest/route"));
    ({ POST: wikiPOST } = await import("@/app/api/v1/soul/wiki/route"));
    ({ incrementalCompile } = await import("@/lib/soul-wiki/compile"));
    ({ DEFAULT_SONNET_MODEL } = await import("@/lib/ai/models"));
    const { encryptValue } = await import("@/lib/encryption");

    const byok = JSON.stringify({ anthropic: { apiKey: encryptValue(BYOK_KEY) } });
    const bad = JSON.stringify({ anthropic: { apiKey: encryptValue(BAD_KEY) } });
    await db.execute(sql`insert into organizations (id, name, slug, plan, integrations, soul) values
      (${BYOK_ORG}::uuid, 'byok', 'soulc-byok', 'free', ${byok}::jsonb, '{"businessName":"Fixture Co","industry":"fixtures"}'::jsonb),
      (${NOKEY_ORG}::uuid, 'nokey', 'soulc-nokey', 'free', '{}'::jsonb, '{}'::jsonb),
      (${PLATFORM_ORG}::uuid, 'platform', 'soulc-platform', 'free', '{}'::jsonb, '{}'::jsonb),
      (${BADKEY_ORG}::uuid, 'badkey', 'soulc-badkey', 'free', ${bad}::jsonb, '{}'::jsonb)`);
    await db.execute(sql`insert into users (id, org_id, name, email, role) values
      (${U(1)}::uuid, ${BYOK_ORG}::uuid, 'byok', 'soulc-byok@fixture.test', 'owner'),
      (${U(2)}::uuid, ${NOKEY_ORG}::uuid, 'nokey', 'soulc-nokey@fixture.test', 'owner'),
      (${U(3)}::uuid, ${PLATFORM_ORG}::uuid, 'platform', 'soulc-platform@fixture.test', 'owner'),
      (${U(4)}::uuid, ${BADKEY_ORG}::uuid, 'badkey', 'soulc-badkey@fixture.test', 'owner')`);
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  });

  test("(a) org BYOK key, no ANTHROPIC_API_KEY env: ingest compiles 8 articles on the workspace's own key and the source becomes 'compiled'", async () => {
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    const before = calls.length;
    await ingestAs(U(1), BYOK_ORG, "Fixture Co sells synthetic fixtures to synthetic clients.");
    const [source] = await settle(BYOK_ORG, ["pending"]);
    assert.equal(source.status, "compiled", JSON.stringify(source));
    assert.equal(source.metadata.compileError, undefined);
    assert.equal(source.metadata.wordCount, 8, "the ingest metadata is untouched");
    const made = calls.slice(before);
    assert.equal(made.length, 8, "one model call per category");
    assert.ok(made.every((c) => c.apiKey === BYOK_KEY && c.host === "api.anthropic.com" && c.model === DEFAULT_SONNET_MODEL), JSON.stringify(made[0]));
    assert.equal(await wikiCount(BYOK_ORG), 8);
  });

  test("(b) no key anywhere: the source becomes 'failed' with a reason, no model call; positive control: with a key, Recompile All compiles it in the same harness", async () => {
    const before = calls.length;
    await ingestAs(U(2), NOKEY_ORG, "Nokey Co sells synthetic fixtures.");
    const [failed] = await settle(NOKEY_ORG, ["pending"]);
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.equal(failed.metadata.compileError, "no model key configured");
    assert.equal(failed.metadata.wordCount, 5, "the failure reason is merged, ingest metadata kept");
    assert.equal(calls.length, before, "no model call was attempted");
    assert.equal(await wikiCount(NOKEY_ORG), 0);

    // positive control + retry path: the same workspace gets a key, the owner presses Recompile All.
    const { encryptValue } = await import("@/lib/encryption");
    await db.execute(sql`update organizations set integrations = ${JSON.stringify({ anthropic: { apiKey: encryptValue(BYOK_KEY) } })}::jsonb where id = ${NOKEY_ORG}::uuid`);
    await recompileAs(U(2), NOKEY_ORG);
    const [retried] = await settle(NOKEY_ORG, ["failed"]);
    assert.equal(retried.status, "compiled", JSON.stringify(retried));
    assert.equal(retried.metadata.compileError, undefined, "a successful compile clears the old reason");
    assert.equal(calls.length - before, 8);
    assert.equal(await wikiCount(NOKEY_ORG), 8);
  });

  test("(c) platform file-backed provider: resolution.model (MODEL_NAME) is the model used, on MODEL_BASE_URL with the file's key", async () => {
    const keyFile = path.join(dir, "platform-key");
    await writeFile(keyFile, `${PLATFORM_FILE_KEY}\n`, "utf8");
    process.env.MODEL_API_KEY_FILE = keyFile;
    process.env.MODEL_BASE_URL = PLATFORM_BASE_URL;
    process.env.MODEL_NAME = PLATFORM_MODEL;
    try {
      const before = calls.length;
      await ingestAs(U(3), PLATFORM_ORG, "Platform Co sells synthetic fixtures.");
      const [source] = await settle(PLATFORM_ORG, ["pending"]);
      assert.equal(source.status, "compiled", JSON.stringify(source));
      const made = calls.slice(before);
      assert.equal(made.length, 8);
      assert.ok(made.every((c) => c.model === PLATFORM_MODEL && c.host === "platform-model.fixture.test" && c.apiKey === PLATFORM_FILE_KEY), JSON.stringify(made[0]));
      // control: the platform model is genuinely distinct from the default, so the assertion above cannot pass by accident
      assert.notEqual(PLATFORM_MODEL, DEFAULT_SONNET_MODEL);

      // Recompile All on the same workspace uses the same resolved model.
      const before2 = calls.length;
      await recompileAs(U(3), PLATFORM_ORG);
      for (let i = 0; i < 150 && calls.length - before2 < 8; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(calls.slice(before2).length === 8 && calls.slice(before2).every((c) => c.model === PLATFORM_MODEL));
    } finally {
      delete process.env.MODEL_API_KEY_FILE;
      delete process.env.MODEL_BASE_URL;
      delete process.env.MODEL_NAME;
    }
  });

  test("(d) the provider rejects the key: 'failed' with the provider error, and the reason never carries the key", async () => {
    await ingestAs(U(4), BADKEY_ORG, "Badkey Co sells synthetic fixtures.");
    const [source] = await settle(BADKEY_ORG, ["pending"]);
    assert.equal(source.status, "failed", JSON.stringify(source));
    const reason = String(source.metadata.compileError);
    assert.match(reason, /^Error: 401 .*authentication_error/, "the provider status and error type reach the operator");
    assert.equal(reason.includes(BAD_KEY), false, reason);
    assert.match(reason, /\[redacted\]/, "control: the provider message did contain the key, and it was removed");
    assert.ok(reason.length <= 200);
  });

  test("(e) incrementalCompile (install/seed/event callers) also fails visibly with no key", async () => {
    await db.execute(sql`update organizations set integrations = '{}'::jsonb where id = ${NOKEY_ORG}::uuid`);
    const [row] = await rows<{ id: string }>(sql`insert into soul_sources (org_id, type, title, raw_content, metadata, status)
      values (${NOKEY_ORG}::uuid, 'text', 'incremental', 'Incremental fixture text.', '{"wordCount":3}'::jsonb, 'pending') returning id::text`);
    await assert.rejects(incrementalCompile(NOKEY_ORG, row.id), /no model key configured/);
    const s = (await sourcesOf(NOKEY_ORG)).find((r) => r.id === row.id)!;
    assert.equal(s.status, "failed");
    assert.equal(s.metadata.compileError, "no model key configured");
    // control: the earlier compiled source of the same workspace was not touched by this incremental failure
    assert.ok((await sourcesOf(NOKEY_ORG)).some((r) => r.id !== row.id && r.status === "compiled"));
  });
});
