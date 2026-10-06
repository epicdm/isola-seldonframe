export function parseAppHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^https?:\\/\\//, "").replace(/\\/.*$/, "").replace(/:\\d+$/, ""))
    .filter((host) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host));
}

export function extraAppHosts(env: Record<string, string | undefined> = process.env): string[] {
  return parseAppHosts(env.APP_HOSTS);
}

export function primaryAppHost(env: Record<string, string | undefined> = process.env): string | null {
  return extraAppHosts(env)[0] ?? null;
}
