/** Accept only same-origin absolute paths; reject protocol-relative and foreign targets. */
export function safeInternalRedirect(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\r\n]/.test(candidate)) return fallback;
  try {
    const base = new URL("https://redirect.invalid");
    const target = new URL(candidate, base);
    if (target.origin !== base.origin) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}
