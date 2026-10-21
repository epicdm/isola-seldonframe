// EPIC 2026-10-21: owner/admin-only area (Port def-uplink-staff-access-admin-only-invite-and-no-session-revocation-2026-10-21).
// A staff member is sent to the dashboard. This is the PAGE half only; every action behind these pages is also refused
// server-side (lib/auth/staff-access-policy.ts).
import { redirectUnlessWorkspaceAdmin } from "@/lib/auth/require-workspace-role";

export default async function AdminOnlyLayout({ children }: { children: React.ReactNode }) {
  await redirectUnlessWorkspaceAdmin();
  return children;
}
