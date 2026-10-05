import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, organizations } from "@/db/schema";
import { composeVoicePersona } from "@/lib/agents/voice/persona";
import { loadVoicePersonaInputs } from "@/lib/agents/voice/voice-workspace";
import { resolveV1Identity } from "@/lib/auth/v1-identity";
import { authorizeVoiceContextBinding } from "@/lib/agents/voice/scoped-native-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await resolveV1Identity(request);
  if (!auth.ok) return auth.response;
  const identityWorkspaceId =
    auth.identity.kind === "workspace" ? auth.identity.orgId : null;
  const body: unknown = await request.json().catch(() => null);
  const authorization = authorizeVoiceContextBinding({
    identityWorkspaceId,
    body,
    allowlistJson: process.env.SF_VOICE_CONTEXT_ALLOWLIST,
  });
  if (!authorization.ok) {
    return NextResponse.json(
      {
        error:
          authorization.status === 503
            ? "voice_context_unavailable"
            : authorization.status === 403
              ? "workspace_scope_mismatch"
              : "not_found",
      },
      {
        status: authorization.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const { workspaceId, agentSlug } = authorization.binding;
  const [agent] = await db
    .select({
      id: agents.id,
      orgId: agents.orgId,
      name: agents.name,
      slug: agents.slug,
      channel: agents.channel,
      archetype: agents.archetype,
      blueprint: agents.blueprint,
      status: agents.status,
      version: agents.currentVersion,
    })
    .from(agents)
    .where(and(eq(agents.orgId, workspaceId), eq(agents.slug, agentSlug)))
    .limit(1);

  if (
    !agent ||
    !["voice", "web_chat"].includes(agent.channel) ||
    !["test", "live"].includes(agent.status)
  ) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const [workspace] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, workspaceId))
    .limit(1);
  const inputs = await loadVoicePersonaInputs(workspaceId, agent.id);
  const instructions = composeVoicePersona({
    soul: inputs.soul,
    blueprint: agent.blueprint,
    timezone: inputs.timezone,
    now: new Date(),
    intakeFields: inputs.intakeFields,
  });
  if (!instructions.trim() || instructions.length > 12000) {
    return NextResponse.json(
      { error: "voice_context_invalid" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      source: "seldonframe-native",
      workspaceId,
      agentSlug: agent.slug,
      name: agent.name,
      workspaceName: workspace?.name ?? "",
      channel: agent.channel,
      status: agent.status,
      version: agent.version,
      instructions,
      greeting: agent.blueprint.greeting ?? null,
      voice: agent.blueprint.voice ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

