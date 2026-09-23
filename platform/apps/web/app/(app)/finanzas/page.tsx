import type { Metadata } from "next";
import Link from "next/link";
import { rateToPct } from "@mc/core";
import { getReceivablesKpis, listInvoices, listReminders, type InvoiceListRow } from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { BandejaRecordatorios } from "./bandeja";
import { withWorkspace } from "./_lib/db";
import { LIST_FILTERS, filterKey, pillForInvoice, type ListFilterKey } from "./_lib/estado";

export const metadata: Metadata = { title: "Finanzas" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Las columnas se construyen con el formateador del workspace, no con
 * el de por defecto. Antes eran una constante de módulo y formateaban
 * con es-CO fijo: un workspace en MXN/en-US veía los KPI en su locale y
 * las filas en el de Colombia, en la misma pantalla.
 */
const columnas = (f: Formatter): Column<InvoiceListRow>[] => [
  {
    key: "company",
    header: "Marca",
    render: (r) => <CellMain sub={r.number}>{r.companyName}</CellMain>,
  },
  {
    key: "campaign",
    header: "Campaña",
    render: (r) => <span className={r.campaignName ? "" : "text-fg-3"}>{r.campaignName ?? "Sin campaña"}</span>,
  },
  {
    key: "total",
    header: "Monto",
    align: "num",
    render: (r) => (
      <CellMain sub={r.status === "partial" ? `pendiente ${f.money(r.outstanding, r.currency, { mode: "full" })}` : undefined}>
        {f.money(r.total, r.currency, { mode: "full" })}
      </CellMain>
    ),
  },
  {
    key: "dueOn",
    header: "Vence",
    render: (r) =>
      r.bucket === "pagada" || r.bucket === "anulada" ? (
        <span className="text-fg-3">{f.date(r.dueOn)}</span>
      ) : (
        <CellMain sub={f.daysRelative(r.daysToDue)}>{f.date(r.dueOn)}</CellMain>
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
    <nav aria-label="Filtrar facturas" className="flex flex-wrap gap-1.5">
      {(Object.keys(LIST_FILTERS) as ListFilterKey[]).map((key) => {
        const on = key === active;
        return (
          <Link
            key={key}
            href={key === "todas" ? "/finanzas" : `/finanzas?estado=${key}`}
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

export default async function FinanzasPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const params = await searchParams;
  const filter = filterKey(params.estado);
  const statuses = LIST_FILTERS[filter].statuses;

  const { kpis, invoices, recordatorios } = await withWorkspace(async (tx) => ({
    kpis: await getReceivablesKpis(tx),
    invoices: await listInvoices(tx, { status: statuses ? [...statuses] : undefined, limit: 100 }),
    // La bandeja de FIN-4: lo que el job dejó redactado y todavía no se
    // ha marcado como enviado. El filtro de la lista no la toca.
    recordatorios: await listReminders(tx, { pendingOnly: true }),
  }));
  // Los KPI suman facturas de todo el workspace, así que van en SU
  // moneda (workspace.currency), no en una constante. Cada fila, en
  // cambio, muestra la moneda con la que se emitió. Locale, moneda y
  // zona horaria vienen atados en el mismo formateador.
  const f = formatterFor(await getCurrentWorkspace());

  const year = new Date().getUTCFullYear();
  const overdueNote =
    kpis.overdueCount === 0
      ? "Ninguna vencida"
      : `${kpis.overdueCount} ${kpis.overdueCount === 1 ? "factura" : "facturas"} · ${kpis.maxDaysOverdue} días`;

  return (
    <>
      <PageHeader
        eyebrow="Finanzas"
        title="Quién te debe, cuándo entra la plata y cuánto apartar"
        description="Cada campaña cerrada crea su factura y su fecha esperada de cobro. Los estados de mora salen de la vista receivables; el IVA y la retención, de la misma función que usa el formulario."
        aside={
          <div className="flex flex-wrap gap-2">
            <Button href="/finanzas/flujo">Flujo de caja</Button>
            <Button variant="primary" href="/finanzas/facturas/nueva">
              Nueva factura
            </Button>
          </div>
        }
      />

      <KpiRow>
        <Kpi
          label="Por cobrar"
          value={f.money(kpis.outstanding, undefined, { mode: "compact" })}
          note={`${kpis.openCount} ${kpis.openCount === 1 ? "factura" : "facturas"}`}
          href="/finanzas?estado=por_cobrar"
        />
        <Kpi label="Vencido" value={f.money(kpis.overdue, undefined, { mode: "compact" })} note={overdueNote} />
        <Kpi
          label={`Cobrado en ${year}`}
          value={f.money(kpis.collectedYtd, undefined, { mode: "compact" })}
          delta={kpis.collectedDelta ?? undefined}
          deltaLabel={kpis.collectedDelta === null ? undefined : `vs. mismo período ${year - 1}`}
          note={kpis.collectedDelta === null ? `Sin cobros en ${year - 1} para comparar` : undefined}
        />
        <Kpi
          label="Apartado para impuestos"
          value={f.money(kpis.taxReserved, undefined, { mode: "compact" })}
          note={kpis.taxRate ? `${rateToPct(kpis.taxRate)} % de cada cobro` : "Sin reservas todavía"}
        />
      </KpiRow>

      <BandejaRecordatorios rows={recordatorios} f={f} />

      <section className="mt-10" aria-labelledby="facturas">
        <SectionTitle meta={`${invoices.rows.length} ${invoices.rows.length === 1 ? "factura" : "facturas"}`}>
          <span id="facturas">Facturas</span>
        </SectionTitle>
        <div className="mb-3">
          <Filters active={filter} />
        </div>
        <DataTable
          columns={columnas(f)}
          rows={invoices.rows}
          rowKey={(r) => r.id}
          caption="Facturas emitidas a marcas, con su estado de cobro"
          emptyState={
            filter === "todas" ? (
              <EmptyState
                title="Todavía no hay facturas"
                description="La primera puede salir de una campaña del seed o escribirse a mano. Queda en borrador hasta que la marques como enviada."
                action={{ label: "Crear tu primera factura", href: "/finanzas/facturas/nueva" }}
              />
            ) : (
              <EmptyState
                title={`No hay facturas en «${LIST_FILTERS[filter].label}»`}
                description="Prueba con otro filtro o crea una factura nueva."
                action={{ label: "Ver todas", href: "/finanzas" }}
              />
            )
          }
        />
      </section>
    </>
  );
}
