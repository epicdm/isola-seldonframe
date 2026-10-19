// Phone & WhatsApp: a READ-ONLY view of this workspace's WhatsApp business number(s), calling eligibility, call
// destination, routing readiness and last call. Part one of the journey: connect -> select number -> configure
// destination -> verify routing -> acceptance call. This page shows evidence; EPIC staff perform every change.
//
// Identity: the ONLY input is getOrgId() (server session). This page reads no params, no searchParams, no cookies of its own
// and renders no input that could name a number or workspace. There is no write action, no server action and no form.
import { notFound, redirect } from "next/navigation";

import { getOrgId } from "@/lib/auth/helpers";
import { isPhoneWhatsappEnabled } from "@/lib/phone-whatsapp/exposure";
import { loadPhoneWhatsappView } from "@/lib/phone-whatsapp/service";
import { getServiceDeps, getStaffSetupWhatsapp } from "@/lib/phone-whatsapp/server";
import { PhoneWhatsappView } from "./view";

export const dynamic = "force-dynamic";

export default async function PhoneWhatsappPage() {
  const orgId = await getOrgId();
  if (!orgId) redirect("/login");
  // Deployment is not exposure: the page exists in the image but answers 404 until this workspace is enabled (same function as the nav entry).
  if (!isPhoneWhatsappEnabled(orgId, process.env.PHONE_WHATSAPP_ENABLED_ORGS)) notFound();

  const view = await loadPhoneWhatsappView(orgId, getServiceDeps());
  return <PhoneWhatsappView view={view} waNumber={getStaffSetupWhatsapp()} />;
}
