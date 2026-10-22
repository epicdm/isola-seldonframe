// v1.30.2 — Docs article: Custom domains.

import { ArticleShell, Callout, InAppLink, Step, UpstreamNotice } from "../../article-shell";

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

      <Step n={1} title="Ask EPIC to add the domain">
        Upstream does this in <InAppLink href="/settings/domains">Settings → Domains</InAppLink> with "Add domain." On Uplink, ask EPIC first: whether you can do it yourself is not verified.
      </Step>

      <Step n={2} title="Add the DNS records at your registrar">
        The records depend on where the workspace is hosted. Do not copy records from other sources: check with EPIC for the exact values for your domain.
      </Step>

      <Step n={3} title="Wait for DNS to propagate">
        DNS changes take time to propagate.
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

      <h2>Next</h2>
      <ul>
        <li><InAppLink href="/docs/your-business/branding">Branding & theme</InAppLink></li>
      </ul>
    </ArticleShell>
  );
}
