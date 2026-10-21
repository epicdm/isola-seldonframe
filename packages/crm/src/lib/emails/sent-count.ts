// "manual" rows were never handed to any transport, so they are not sends.
export function countSentEmails(rows: ReadonlyArray<{ provider: string }>): number {
  return rows.filter((r) => r.provider.toLowerCase() !== "manual").length;
}
