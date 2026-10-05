export type VoiceContextBinding = {
  workspaceId: string;
  agentSlug: string;
};

export type VoiceContextAuthorization =
  | { ok: true; binding: VoiceContextBinding }
  | { ok: false; status: 403 | 404 | 503 };

export function authorizeVoiceContextBinding(args: {
  identityWorkspaceId: string | null;
  body: unknown;
  allowlistJson: string | undefined;
}): VoiceContextAuthorization {
  if (!args.allowlistJson) return { ok: false, status: 503 };
  if (!args.identityWorkspaceId) return { ok: false, status: 403 };

  let allowlist: unknown;
  try {
    allowlist = JSON.parse(args.allowlistJson);
  } catch {
    return { ok: false, status: 503 };
  }
  if (!allowlist || typeof allowlist !== "object" || Array.isArray(allowlist)) {
    return { ok: false, status: 503 };
  }

  const body = args.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 404 };
  }
  const request = body as Record<string, unknown>;
  const workspaceId = request.workspaceId;
  const agentSlug = request.agentSlug;
  if (
    typeof workspaceId !== "string" ||
    typeof agentSlug !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      workspaceId,
    ) ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(agentSlug)
  ) {
    return { ok: false, status: 404 };
  }
  if (args.identityWorkspaceId !== workspaceId) {
    return { ok: false, status: 403 };
  }

  const expectedSlug = (allowlist as Record<string, unknown>)[workspaceId];
  if (typeof expectedSlug !== "string" || expectedSlug !== agentSlug) {
    return { ok: false, status: 404 };
  }
  return { ok: true, binding: { workspaceId, agentSlug } };
}

