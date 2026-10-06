// EPIC 2026-10-06 -- operator (admin) hostnames for a self-hosted install.
//
// proxy.ts hard-codes the app hosts (app.seldonframe.com, localhost, 127.0.0.1, *.vercel.app). A self-hoster serving the
// dashboard on its own hostname (e.g. agents.example.com) had that host treated as a workspace custom domain, so installs
// worked around it by rewriting Host to localhost (which then broke Server Actions origin checks: logout failed, and
// absolute URLs leaked "localhost"). APP_HOSTS="host1,host2" declares extra app hosts. Unset = behaviour unchanged.

export function parseAppHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""))
    .filter((h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h));
}

export function extraAppHosts(env: Record<string, string | undefined> = process.env): string[] {
  return parseAppHosts(env.APP_HOSTS);
}

/** First declared app host, used to build admin links; null when APP_HOSTS is unset. */
export function primaryAppHost(env: Record<string, string | undefined> = process.env): string | null {
  return extraAppHosts(env)[0] ?? null;
}
