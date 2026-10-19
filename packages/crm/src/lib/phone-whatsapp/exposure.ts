// Exposure control: deploying the page is not the same as showing it. A workspace sees the Phone & WhatsApp nav entry and page only
// when its id is listed in PHONE_WHATSAPP_ENABLED_ORGS (comma separated), or the value is "*". Unset or empty = nobody (default off).
// ONE function, keyed on ONE field (the workspace id from the server session), used by BOTH the nav entry and the page, so the two
// gates cannot disagree about who is enabled.
const UUID_OR_ID = /^[0-9a-z][0-9a-z-]{7,63}$/i;

export function isPhoneWhatsappEnabled(orgId: string | null | undefined, raw: string | undefined): boolean {
  if (typeof orgId !== "string" || !UUID_OR_ID.test(orgId)) return false;
  const list = (raw ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  return list.includes(orgId.toLowerCase());
}
