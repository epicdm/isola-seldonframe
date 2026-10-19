/**
 * /admin/invalid — landing page for failed admin-token redirects.
 *
 * Reached when /admin/[workspaceId]?token=… fails validation. Static
 * server component (no client JS) so it loads instantly and never
 * leaks the original token (we never echo `token` into the response).
 */
import { resolvePlatformBranding } from "@/lib/branding/platform";

type Props = {
  searchParams: Promise<{ reason?: string }>;
};

const REASON_COPY: Record<string, { title: string; body: string }> = {
  "missing-token": {
    title: "Missing admin token",
    body:
      "This page requires an admin token in the URL. If you're an operator, paste the full admin URL Claude Code returned when it created the workspace — it ends with `?token=wst_…`.",
  },
  "expired-or-unknown": {
    title: "Admin link expired or invalid",
    body:
      "Admin links expire after 7 days. Run `list_workspaces({})` in Claude Code to mint a fresh admin URL, or ask Claude to do it for you.",
  },
  "workspace-mismatch": {
    title: "Token / workspace mismatch",
    body:
      "The admin token doesn't grant access to the workspace in this URL. Double-check that you used the most recent admin URL Claude Code returned for *this* workspace.",
  },
};

export default async function AdminInvalidPage({ searchParams }: Props) {
  const params = await searchParams;
  const reason = params.reason ?? "expired-or-unknown";
  const copy = REASON_COPY[reason] ?? REASON_COPY["expired-or-unknown"];
  const brand = resolvePlatformBranding();
  const body = brand.name === "SeldonFrame"
    ? copy.body
    : "This workspace link is missing or invalid. Sign in and open the workspace from your workspace list, or contact the workspace administrator.";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#FAFAF7",
        padding: "2rem",
        fontFamily:
          '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 520,
          background: "#FFFFFF",
          border: "1px solid #E6E2D9",
          borderRadius: 16,
          padding: "2.5rem",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.04)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            fontWeight: 600,
            color: "#666666",
            marginBottom: 12,
          }}
        >
          Admin access
        </p>
        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "#1A1A1A",
            marginBottom: 12,
          }}
        >
          {copy.title}
        </h1>
        <p
          style={{
            margin: 0,
            color: "#505050",
            lineHeight: 1.6,
            fontSize: 16,
          }}
        >
          {body}
        </p>
        <p
          style={{
            marginTop: "1.5rem",
            fontSize: 13,
            color: "#999999",
          }}
        >
          {brand.name === "SeldonFrame" ? <>Need help? Run <code>get_workspace_snapshot({"{}"})</code> in Claude Code, or visit{" "}
          <a
            href="https://seldonframe.com/docs/admin-access"
            style={{ color: "#1A1A1A", textDecoration: "underline" }}
          >
            seldonframe.com/docs/admin-access
          </a>
          .</> : brand.supportEmail && !brand.supportEmail.endsWith("@seldonframe.com")
            ? <>Need help? <a href={`mailto:${brand.supportEmail}`} style={{ color: "#1A1A1A", textDecoration: "underline" }}>Contact {brand.name} support</a>.</>
            : "Contact your workspace administrator if you still need help."}
        </p>
      </div>
    </main>
  );
}
