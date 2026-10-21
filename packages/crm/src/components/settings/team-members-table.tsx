// EPIC 2026-10-21 — Settings > Team member list with owner controls: change role (staff/admin), switch the
// "Ask an employee" permission (default off) and remove. Every control calls an owner-only server action that
// re-checks authority; the change applies on the member's next request.

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  removeWorkspaceMemberAction,
  setMemberAskEmployeePermissionAction,
  setWorkspaceMemberRoleAction,
} from "@/lib/operator-portal/auth";

export type TeamMemberRow = {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "staff";
  manageable: boolean;
  askEmployee: boolean;
};

const ROLE_LABEL: Record<TeamMemberRow["role"], string> = { owner: "Owner", admin: "Admin", staff: "Staff" };

export function TeamMembersTable({ orgSlug, rows, canManage }: { orgSlug: string; rows: TeamMemberRow[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: true } | { ok: false; reason: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(humanize(res.reason));
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="crm-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[hsl(var(--color-surface-raised))] text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Ask an employee</th>
              {canManage ? <th className="px-3 py-2 text-right">Access</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="px-3 py-4 text-center text-muted-foreground">
                  No team members yet. Send an operator invite above.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.userId} className="border-t">
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2">{row.email}</td>
                  <td className="px-3 py-2">
                    {canManage && row.manageable ? (
                      <select
                        aria-label={`Role for ${row.email}`}
                        value={row.role}
                        disabled={pending}
                        onChange={(e) => run(() => setWorkspaceMemberRoleAction({ orgSlug, userId: row.userId, role: e.target.value }))}
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                      >
                        <option value="staff">Staff</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      ROLE_LABEL[row.role]
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {canManage && row.manageable ? (
                      <label className="inline-flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={row.askEmployee}
                          disabled={pending}
                          onChange={(e) => run(() => setMemberAskEmployeePermissionAction({ orgSlug, userId: row.userId, enabled: e.target.checked }))}
                        />
                        {row.askEmployee ? "On" : "Off"}
                      </label>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.askEmployee ? "On" : "Off"}</span>
                    )}
                  </td>
                  {canManage ? (
                    <td className="px-3 py-2 text-right">
                      {row.manageable ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            if (window.confirm(`Remove ${row.email}? Their access ends on their next click.`)) {
                              run(() => removeWorkspaceMemberAction({ orgSlug, userId: row.userId }));
                            }
                          }}
                          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-destructive hover:bg-muted/50 disabled:opacity-60"
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Staff can work with contacts, conversations, activities, deals and bookings. Settings, billing, payments, API keys,
        integrations, agents, automations, domains and the team are for owners and admins.
      </p>
    </div>
  );
}

function humanize(reason: string): string {
  switch (reason) {
    case "not_signed_in":
      return "Your session expired. Sign in again.";
    case "not_authorized_for_workspace":
      return "Only the workspace owner can change the team.";
    case "cannot_change_owner":
      return "The owner can't be changed here.";
    case "member_not_found":
      return "That person is no longer a member.";
    case "invalid_role":
      return "Choose Staff or Admin.";
    default:
      return reason;
  }
}
