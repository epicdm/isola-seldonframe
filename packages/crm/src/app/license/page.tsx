import type { Metadata } from "next";
import { resolvePlatformBranding } from "@/lib/branding/platform";

const brand = resolvePlatformBranding();

export const metadata: Metadata = {
  title: "Open-source notices",
  description: `Open-source license notices for ${brand.name}.`,
  alternates: { canonical: "/license" },
};

export default function LicenseNoticesPage() {
  const sourceUrl = brand.sourceUrl;
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-6 py-12 text-foreground">
      <h1 className="text-2xl font-semibold">Open-source notices</h1>
      <p>{brand.name} includes SeldonFrame software licensed under the GNU Affero General Public License, version 3 (AGPL-3.0).</p>
      <p>Copyright © 2026 SeldonFrame, Inc. The upstream source license and notices are preserved in the source distribution.</p>
      <p>The software is provided without warranty except where applicable law requires otherwise. Recipients may convey and modify the covered software under AGPL-3.0.</p>
      <p><a className="underline" href="https://www.gnu.org/licenses/agpl-3.0.html">Read the GNU AGPL version 3 license</a>.</p>
      <p>Upstream SeldonFrame logo and wordmark assets are not included in this white-label branding; upstream copyright and license notices remain in the source distribution.</p>
      {sourceUrl ? (
        <p><a className="underline" href={sourceUrl}>View corresponding source code</a></p>
      ) : (
        <p>To request the corresponding source for this network service, contact <a className="underline" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.</p>
      )}
      <p className="text-sm text-muted-foreground">{brand.name} is operated by {brand.operatorName}.</p>
    </main>
  );
}
