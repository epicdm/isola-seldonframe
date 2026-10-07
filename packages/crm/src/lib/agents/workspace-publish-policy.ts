/** Workspace credentials may publish only through the normal evaluation gate. */
export function isWorkspaceForcePublishDenied(force: unknown): boolean {
  return force === true;
}
