// Phone & WhatsApp: a READ-ONLY view of this workspace's WhatsApp business number(s), calling eligibility, call
// destination, routing readiness and last call. Part one of the journey: connect -> select number -> configure
// destination -> verify routing -> acceptance call. This page shows evidence; EPIC staff perform every change.
//
// Identity: the ONLY input is getOrgId() (server session). This page reads no params, no searchParams, no cookies of its own
// and renders no input that could name a number or workspace. There is no write action, no server action and no form.
import { notFound, redirect } from "next/navigation";

import { getCurrentWorkspaceRole, getOrgId } from "@/lib/auth/helpers";
import { isConnectEnabled } from "@/lib/phone-whatsapp/connect/config";
import { isPhoneWhatsappEnabled } from "@/lib/phone-whatsapp/exposure";
import { loadPhoneWhatsappView } from "@/lib/phone-whatsapp/service";
import { getServiceDeps, getStaffSetupWhatsapp } from "@/lib/phone-whatsapp/server";
import { listConnectionStates } from "@/lib/phone-whatsapp/connect/server-wiring";
import { ConnectPanel } from "./connect-panel";
import { PhoneWhatsappView } from "./view";

export const dynamic = "force-dynamic";

export default async function PhoneWhatsappPage() {
  const orgId = await getOrgId();
  if (!orgId) redirect("/login");
  // Deployment is not exposure: the page exists in the image but answers 404 until this workspace is enabled (same function as the nav entry).
  if (!isPhoneWhatsappEnabled(orgId, process.env.PHONE_WHATSAPP_ENABLED_ORGS)) notFound();

  const view = await loadPhoneWhatsappView(orgId, getServiceDeps());
  // Connecting a number is a separate, narrower exposure (PHONE_CONNECT_ENABLED_ORGS) and an owner/admin action. The API re-checks all of it.
  const role = isConnectEnabled(orgId, process.env) ? await getCurrentWorkspaceRole() : null;
  const canConnect = role === "owner" || role === "admin";
  return (
    <>
      {canConnect ? <ConnectPanel states={await listConnectionStates(orgId)} /> : null}
      <PhoneWhatsappView view={view} waNumber={getStaffSetupWhatsapp()} canConnect={canConnect} />
    </>
  );
}
