import type { Metadata } from "next";
import Link from "next/link";
import { rateToPct } from "@mc/core";
import { getReceivablesKpis, listInvoices, type InvoiceListRow } from "@mc/db";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import { formatDate, formatDaysRelative, formatMoney } from "@/lib/format";
import { withWorkspace } from "./_lib/db";
import { LIST_FILTERS, filterKey, pillForInvoice, type ListFilterKey } from "./_lib/estado";

export const metadata: Metadata = { title: "Finanzas" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const COLUMNS: Column<InvoiceListRow>[] = [
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
      <CellMain sub={r.status === "partial" ? `pendiente ${formatMoney(r.outstanding, r.currency)}` : undefined}>
        {formatMoney(r.total, r.currency)}
      </CellMain>
    ),
  },
  {
    key: "dueOn",
    header: "Vence",
    render: (r) =>
      r.bucket === "pagada" || r.bucket === "anulada" ? (
        <span className="text-fg-3">{formatDate(r.dueOn)}</span>
      ) : (
        <CellMain sub={formatDaysRelative(r.daysToDue)}>{formatDate(r.dueOn)}</CellMain>
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

  const { kpis, invoices } = await withWorkspace(async (tx) => ({
    kpis: await getReceivablesKpis(tx),
    invoices: await listInvoices(tx, { status: statuses ? [...statuses] : undefined, limit: 100 }),
  }));

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
          <Button variant="primary" href="/finanzas/facturas/nueva">
            Nueva factura
          </Button>
        }
      />

      <KpiRow>
        <Kpi
          label="Por cobrar"
          value={formatMoney(kpis.outstanding, "COP", { mode: "compact" })}
          note={`${kpis.openCount} ${kpis.openCount === 1 ? "factura" : "facturas"}`}
          href="/finanzas?estado=por_cobrar"
        />
        <Kpi label="Vencido" value={formatMoney(kpis.overdue, "COP", { mode: "compact" })} note={overdueNote} />
        <Kpi
          label={`Cobrado en ${year}`}
          value={formatMoney(kpis.collectedYtd, "COP", { mode: "compact" })}
          delta={kpis.collectedDelta ?? undefined}
          deltaLabel={kpis.collectedDelta === null ? undefined : `vs. mismo período ${year - 1}`}
          note={kpis.collectedDelta === null ? `Sin cobros en ${year - 1} para comparar` : undefined}
        />
        <Kpi
          label="Apartado para impuestos"
          value={formatMoney(kpis.taxReserved, "COP", { mode: "compact" })}
          note={kpis.taxRate ? `${rateToPct(kpis.taxRate)} % de cada cobro` : "Sin reservas todavía"}
        />
      </KpiRow>

      <section className="mt-10" aria-labelledby="facturas">
        <SectionTitle meta={`${invoices.rows.length} ${invoices.rows.length === 1 ? "factura" : "facturas"}`}>
          <span id="facturas">Facturas</span>
        </SectionTitle>
        <div className="mb-3">
          <Filters active={filter} />
        </div>
        <DataTable
          columns={COLUMNS}
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
