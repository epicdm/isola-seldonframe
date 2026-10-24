import type { PersonalLineRecord } from "./tenant-data";

type ResolveWorkspaceId = () => Promise<string | null>;

/** HTTP boundary for tenant reads. Workspace identity is resolved only by the server auth layer. */
export function createPersonalLinesListHandler(
  resolveWorkspaceId: ResolveWorkspaceId,
  list: (workspaceId: string, search: string) => Promise<PersonalLineRecord[]>,
) {
  return async (request: Request): Promise<Response> => {
    const workspaceId = await resolveWorkspaceId();
    if (!workspaceId) return Response.json({ error: "unauthorized" }, { status: 401 });
    const search = new URL(request.url).searchParams.get("search") ?? "";
    const lines = await list(workspaceId, search);
    return Response.json({ lines }, { headers: { "Cache-Control": "private, no-store" } });
  };
}

export function createPersonalLineDetailHandler(
  resolveWorkspaceId: ResolveWorkspaceId,
  get: (workspaceId: string, contactId: string) => Promise<PersonalLineRecord | null>,
) {
  return async (_request: Request, contactId: string): Promise<Response> => {
    const workspaceId = await resolveWorkspaceId();
    if (!workspaceId) return Response.json({ error: "unauthorized" }, { status: 401 });
    const line = await get(workspaceId, contactId);
    if (!line) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ line }, { headers: { "Cache-Control": "private, no-store" } });
  };
}
