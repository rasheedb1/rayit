import type { Metadata } from "next";
import Link from "next/link";
import { listCampaigns, type CampaignListRow } from "@mc/db";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { formatDate, formatDateRange, formatInt, formatMoney } from "@/lib/format";
import { withWorkspace } from "@/lib/db";
import { StatusFilter } from "./_lib/filtro-estado";
import { LIST_FILTERS, filterKey, pillForCampaign } from "./_lib/estado";

export const metadata: Metadata = { title: "Campañas" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const COLUMNS: Column<CampaignListRow>[] = [
  { key: "company", header: "Marca", render: (r) => <span className="font-medium text-ink">{r.companyName}</span> },
  {
    key: "name",
    header: "Campaña",
    render: (r) => (
      <Link href={`/campanas/${r.id}`} className="underline-offset-2 hover:underline">
        {r.name}
      </Link>
    ),
  },
  {
    key: "status",
    header: "Estado",
    render: (r) => {
      const p = pillForCampaign(r.status);
      return <Pill kind={p.kind}>{p.text}</Pill>;
    },
  },
  {
    key: "dates",
    header: "Fechas",
    render: (r) =>
      r.startsOn && r.endsOn ? (
        <span className="whitespace-nowrap">{formatDateRange(r.startsOn, r.endsOn)}</span>
      ) : r.startsOn ? (
        <span className="whitespace-nowrap">desde el {formatDate(r.startsOn)}</span>
      ) : (
        <span className="text-fg-3">Sin fechas</span>
      ),
  },
  { key: "posts", header: "Posts", align: "num", render: (r) => formatInt(r.postsCount) },
  {
    key: "views",
    header: "Views",
    align: "num",
    render: (r) =>
      r.viewsTotal === null || r.dataAsOf === null ? (
        <span className="font-sans text-fg-3">Sin datos</span>
      ) : (
        <CellMain sub={`hasta el ${formatDate(r.dataAsOf)}`}>{formatInt(r.viewsTotal)}</CellMain>
      ),
  },
  {
    key: "amount",
    // Total CON impuesto: es lo que se factura (CAM-2, FIN-1). El negocio
    // de Ventas lleva el mismo acuerdo sin IVA (0031); sin decirlo, las
    // dos pantallas parecían dar cifras distintas del mismo trabajo.
    // Pendiente del visto bueno de Nicolás y de moverlo al messages.ts
    // del módulo cuando exista.
    header: "Total con impuesto",
    align: "num",
    render: (r) => (r.amount ? formatMoney(r.amount, r.currency, { mode: "full" }) : <span className="font-sans text-fg-3">Sin monto</span>),
  },
  {
    key: "action",
    header: "Acción",
    render: (r) => (
      <Button size="sm" href={`/campanas/${r.id}`}>
        Ver ficha
      </Button>
    ),
  },
];

export default async function CampanasPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const params = await searchParams;
  const filter = filterKey(params.estado);
  const status = LIST_FILTERS[filter].status;
  const rows = await withWorkspace((tx) => listCampaigns(tx, status ? { status } : {}));

  return (
    <>
      <PageHeader
        eyebrow="Campañas"
        title="Lo que cada campaña produjo, listo para enviar"
        description="La medición se acuerda antes de publicar. Cada campaña reúne lo pactado, sus posts con las views de hoy, el código de seguimiento y, desde aquí, su factura."
      />

      <section aria-labelledby="campanas">
        <SectionTitle meta={`${rows.length} ${rows.length === 1 ? "campaña" : "campañas"}`}>
          <span id="campanas">Campañas</span>
        </SectionTitle>
        <div className="mb-3">
          <StatusFilter active={filter} />
        </div>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          caption="Campañas con la marca, el estado, sus posts, las views actuales y el monto acordado"
          emptyState={
            filter === "todas" ? (
              <EmptyState
                title="Todavía no hay campañas"
                description="La primera llega cuando una cotización se acepta (Cotizar la crea sola) o con el seed de demostración."
              />
            ) : (
              <EmptyState
                title={`No hay campañas en «${LIST_FILTERS[filter].label}»`}
                description="Prueba con otro estado."
                action={{ label: "Ver todas", href: "/campanas" }}
              />
            )
          }
        />
      </section>
    </>
  );
}
