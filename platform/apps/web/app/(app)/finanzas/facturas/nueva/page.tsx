import type { Metadata } from "next";
import { addDays } from "@mc/core";
import { listCampaignsForInvoice, listCompanies } from "@mc/db/queries/finanzas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { MESSAGES } from "../../_lib/messages";
import { NuevaFacturaForm } from "./form";

export const metadata: Metadata = { title: "Nueva factura" };
export const dynamic = "force-dynamic";

export default async function NuevaFacturaPage({
  searchParams,
}: {
  searchParams: Promise<{ campana?: string; error?: string }>;
}) {
  const params = await searchParams;
  const { companies, campaigns } = await withWorkspace(async (tx) => ({
    companies: await listCompanies(tx),
    campaigns: await listCampaignsForInvoice(tx),
  }));
  const { currency, locale } = await getCurrentWorkspace();
  // Hoy en UTC, YYYY-MM-DD: la regla del repo es trabajar en UTC.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        eyebrow="Finanzas · facturas"
        title="Nueva factura"
        description="Queda en borrador con el siguiente número del año. El total se calcula con la misma función que guarda el servidor."
        aside={
          <Button variant="ghost" href="/finanzas/facturas">
            {MESSAGES.facturas.back}
          </Button>
        }
      />
      <NuevaFacturaForm
        companies={companies}
        campaigns={campaigns}
        workspace={{ currency, locale }}
        defaults={{ issuedOn: today, dueOn: addDays(today, 30), campaignId: params.campana ?? "" }}
        initialMessage={params.error}
      />
    </>
  );
}
