import type { Metadata } from "next";
import Link from "next/link";
import { listInvoices, type InvoiceListRow } from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { CeldaVacia } from "../../_componentes/celda-vacia";
import { ModuleTabs } from "../../_componentes/pestanas";
import { withWorkspace } from "../../_lib/db";
import { LIST_FILTERS, filterKey, invoiceFilterHref, pillForInvoice, type ListFilterKey } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";

export const metadata: Metadata = { title: MESSAGES.facturas.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * El archivo completo de facturas: incluye los borradores y las
 * anuladas, que la vista `receivables` excluye y que por tanto no
 * aparecen en /finanzas. Ordenado por emisión, de la más reciente a la
 * más vieja: aquí la pregunta es «qué facturé», no «qué cobro hoy».
 *
 * Las columnas se construyen con el formateador del workspace, no con
 * el de por defecto. Antes eran una constante de módulo y formateaban
 * con es-CO fijo: un workspace en MXN/en-US veía los KPI en su locale y
 * las filas en el de Colombia, en la misma pantalla.
 */
const columnas = (f: Formatter): Column<InvoiceListRow>[] => [
  {
    key: "company",
    header: "Marca",
    // La marca enlaza a la factura, además del botón de la última
    // columna: a 400 px la tabla hace scroll por dentro y ese botón
    // queda fuera de la pantalla (scripts/ancho-movil.mjs con DENTRO).
    render: (r) => (
      <CellMain sub={<span className="whitespace-nowrap font-mono">{r.number}</span>}>
        <Link href={`/finanzas/facturas/${r.id}`} className="underline-offset-2 hover:underline">
          {r.companyName}
        </Link>
      </CellMain>
    ),
  },
  {
    key: "campaign",
    header: "Campaña",
    render: (r) => (r.campaignName ? r.campaignName : <CeldaVacia texto={MESSAGES.cobros.noCampaign} />),
  },
  {
    key: "total",
    header: "Monto",
    align: "num",
    render: (r) => (
      <CellMain
        sub={
          r.status === "partial"
            ? `pendiente ${f.money(r.outstanding, r.currency, { mode: "full" })}`
            : undefined
        }
      >
        {f.money(r.total, r.currency, { mode: "full" })}
      </CellMain>
    ),
  },
  {
    key: "dueOn",
    header: "Vence",
    // Solo la fecha, y corta: los días que faltan o que lleva vencida
    // los dice la pastilla de la columna siguiente, y repetirlos era
    // «16 oct · en 23 días · Al día» en tres columnas seguidas.
    render: (r) => (
      <span className={`whitespace-nowrap ${r.bucket === "pagada" || r.bucket === "anulada" ? "text-fg-3" : ""}`}>
        {f.date(r.dueOn)}
      </span>
    ),
  },
  {
    key: "status",
    header: "Estado",
    render: (r) => {
      const p = pillForInvoice(r);
      return <Pill kind={p.kind}>{p.text}</Pill>;
    },
  },
  {
    key: "action",
    header: "Acción",
    render: (r) => (
      <Button size="sm" href={`/finanzas/facturas/${r.id}`}>
        {r.status === "draft" ? "Completar" : "Ver detalle"}
      </Button>
    ),
  },
];

function Filters({ active }: { active: ListFilterKey }) {
  return (
    <nav aria-label={MESSAGES.facturas.filtersLabel} className="flex flex-wrap gap-1.5">
      {(Object.keys(LIST_FILTERS) as ListFilterKey[]).map((key) => {
        const on = key === active;
        return (
          <Link
            key={key}
            href={invoiceFilterHref(key)}
            aria-current={on ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-fg bg-fg text-bg" : "border-line text-fg-2 hover:border-line-2 hover:text-fg"}`}
          >
            {LIST_FILTERS[key].label}
          </Link>
        );
      })}
    </nav>
  );
}

export default async function FacturasPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const params = await searchParams;
  const filter = filterKey(params.estado);
  const statuses = LIST_FILTERS[filter].statuses;

  const invoices = await withWorkspace((tx) =>
    listInvoices(tx, { status: statuses ? [...statuses] : undefined, limit: 100 }),
  );
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES.facturas;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        aside={
          <Button variant="primary" href="/finanzas/facturas/nueva">
            {t.newInvoice}
          </Button>
        }
      />
      <ModuleTabs active="/finanzas/facturas" />

      <section aria-labelledby="facturas">
        <SectionTitle meta={t.meta(invoices.rows.length)}>
          <span id="facturas">{t.section}</span>
        </SectionTitle>
        <div className="mb-3">
          <Filters active={filter} />
        </div>
        <DataTable
          columns={columnas(f)}
          rows={invoices.rows}
          rowKey={(r) => r.id}
          caption={t.caption}
          emptyState={
            filter === "todas" ? (
              <EmptyState
                title={t.empty.title}
                description={t.empty.description}
                action={{ label: t.empty.action, href: "/finanzas/facturas/nueva" }}
              />
            ) : (
              <EmptyState
                title={t.emptyFiltered.title(LIST_FILTERS[filter].label)}
                description={t.emptyFiltered.description}
                action={{ label: t.emptyFiltered.action, href: "/finanzas/facturas" }}
              />
            )
          }
        />
      </section>
    </>
  );
}
