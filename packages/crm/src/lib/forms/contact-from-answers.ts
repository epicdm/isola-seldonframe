// EPIC 2026-10-04 -- contact fields from a public intake form's answers.
//
// submitPublicIntakeAction created the contact with firstName = data.name ?? "New" and no phone, so a form whose
// name field is keyed fullName (every shipped template) produced a contact called "New" with no phone, while the
// answers sat only in the submission. /api/v1/public/intake already maps these keys; this is the same convention for
// the server action the public form actually calls.

export type ContactFromAnswers = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

export function emailFromAnswers(data: Record<string, unknown>): string | null {
  return pick(data, ["email", "workEmail", "work_email"]);
}

function pick(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    // v1 form submissions lowercase API field keys (for example, fullName to
    // fullname). Match each alias case-insensitively while retaining the
    // caller's semantic alias order above.
    const matchingKey = Object.keys(data).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    const raw = matchingKey === undefined ? undefined : data[matchingKey];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

export function contactFromAnswers(data: Record<string, unknown>): ContactFromAnswers {
  const full = pick(data, ["fullName", "full_name", "name"]);
  let firstName: string | null;
  let lastName: string | null;
  if (full) {
    const parts = full.split(/\s+/);
    firstName = parts[0] ?? null;
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
  } else {
    firstName = pick(data, ["firstName", "first_name"]);
    lastName = pick(data, ["lastName", "last_name"]);
  }
  return { firstName, lastName, phone: pick(data, ["phone", "phoneNumber", "phone_number", "tel", "mobile"]) };
}
