// v1.30.2 — Docs article: Custom domains.

import { ArticleShell, Callout, CodeBlock, InAppLink, Step, UpstreamNotice } from "../../article-shell";

export default function Page() {
  return (
    <ArticleShell
      category="Your business"
      categoryHref="/docs"
      title="Custom domains"
      lede="How custom domains work upstream. On EPIC's Uplink, ask EPIC to set up a custom domain for your workspace."
      githubPath="app/docs/your-business/custom-domains/page.tsx"
    >
      <UpstreamNotice kinds={["domains", "hosts"]} />
      <h2>Setup</h2>

      <Step n={1} title="Add the domain in SeldonFrame">
        <InAppLink href="/settings/domains">Settings → Domains</InAppLink>{" "}
        → "Add domain." Type <code>www.yourbiz.com</code>. SeldonFrame
        gives you the DNS records to add.
      </Step>

      <Step n={2} title="Add the DNS records at your registrar">
        The records depend on where the workspace is hosted. Do not copy records from other sources: EPIC gives you the exact values for your domain.
      </Step>

      <Step n={3} title="Wait for DNS to propagate">
        Usually under 5 minutes, sometimes up to an hour. The Domains
        page shows a green check when verification succeeds.
      </Step>

      <Step n={4} title="HTTPS">
        Certificates and HTTPS behaviour for custom domains on Uplink: check with EPIC.
      </Step>

      <Callout variant="info" title="Apex vs www">
        We recommend using <code>www.yourbiz.com</code> as your primary
        and redirecting the apex (<code>yourbiz.com</code>) to it. This
        is more reliable than apex-as-primary because of how DNS handles
        A records vs CNAMEs at root. Both will work, but www-primary is
        less likely to have edge cases.
      </Callout>

      <h2>What works at your custom domain</h2>
      <ul>
        <li>All your public pages (landing pages, services, blog).</li>
        <li>Your booking pages.</li>
        <li>Your forms (when embedded as iframes from external sites,
            the iframe URL becomes your custom domain).</li>
        <li>The chatbot embed snippet — works the same as on the
            subdomain.</li>
      </ul>

      <h2>Subdomain still works</h2>
      <p>
        Your <code>your-name.uplink.epic.dm</code> subdomain stays
        live as a backup, even after you set up a custom domain. Useful
        for testing.
      </p>

      <h2>Next</h2>
      <ul>
        <li><InAppLink href="/docs/your-business/branding">Branding & theme</InAppLink></li>
      </ul>
    </ArticleShell>
  );
}
