// Same-origin check for the connect API: a cross-site page cannot make a signed-in admin's browser start or finish a connection.
// Pure (takes a Headers-like) so it is testable without the framework.
export function sameOrigin(headers: { get(name: string): string | null }): boolean {
  const origin = headers.get("origin");
  if (!origin) return false; // a browser always sends Origin on a POST; its absence is not a same-origin request
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
