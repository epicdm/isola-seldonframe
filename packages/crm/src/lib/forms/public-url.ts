export function buildPublicFormPath(orgSlug: string, formSlug: string): string {
  return `/forms/${encodeURIComponent(orgSlug)}/${encodeURIComponent(formSlug)}`;
}

export function buildPublicFormUrl(
  orgSlug: string | null,
  formSlug: string,
  origin: string | undefined,
): string | null {
  if (!orgSlug) return null;
  const baseUrl = (origin?.trim() || "https://app.seldonframe.com").replace(/\/+$/, "");
  return `${baseUrl}${buildPublicFormPath(orgSlug, formSlug)}`;
}
