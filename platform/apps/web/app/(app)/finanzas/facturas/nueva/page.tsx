import type { Metadata } from "next";
import { addDays } from "@mc/core";
import { listCampaignsForInvoice, listCompanies } from "@mc/db/queries/finanzas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "../../_lib/db";
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
  // Hoy en UTC, YYYY-MM-DD: la regla del repo es trabajar en UTC.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        eyebrow="Finanzas · facturas"
        title="Nueva factura"
        description="Queda en borrador con el siguiente número del año. El total se calcula con la misma función que guarda el servidor."
        aside={
          <Button variant="ghost" href="/finanzas">
            Volver a facturas
          </Button>
        }
      />
      <NuevaFacturaForm
        companies={companies}
        campaigns={campaigns}
        defaults={{ issuedOn: today, dueOn: addDays(today, 30), campaignId: params.campana ?? "" }}
        initialMessage={params.error}
      />
    </>
  );
}
