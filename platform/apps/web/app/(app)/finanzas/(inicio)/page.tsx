import type { Metadata } from "next";
import Link from "next/link";
import { compareDecimal, rateToPct } from "@mc/core";
import {
  RECEIVABLES_MIN_SEARCH,
  getReceivablesKpis,
  listReceivables,
  receivablesSearchTerm,
  type ReceivableRow,
} from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { CeldaVacia } from "../_componentes/celda-vacia";
import { Filtros } from "../_componentes/filtros";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import {
  RECEIVABLE_FILTERS,
  pillForReceivable,
  receivableFilterKey,
  receivableHref,
} from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";

export const metadata: Metadata = { title: MESSAGES.cobros.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Las columnas se construyen con el formateador del workspace, no con
 * el de por defecto (FIN-1): un workspace en MXN/en-US veía los KPI en
 * su locale y las filas en el de Colombia, en la misma pantalla.
 *
 * A 400 px la fila cabe porque el número de la factura y el monto
 * llevan `whitespace-nowrap` y la fecha va en formato corto («6 ago»):
 * es el hallazgo abierto de `pendientes-pulido.json` sobre las tablas
 * de Cotizar, que aquí se evita desde el principio. Los días de mora no
 * se repiten en la columna «Vence» porque ya están en la pastilla.
 */
const columnas = (f: Formatter): Column<ReceivableRow>[] => {
  const t = MESSAGES.cobros;
  return [
    {
      key: "company",
      header: t.columns.company,
      // La marca es el enlace a la factura, además del botón de la
      // última columna. No es una redundancia: a 400 px la tabla hace
      // scroll por dentro y «Ver factura» queda en x≈612, fuera de la
      // pantalla (lo mide scripts/ancho-movil.mjs con DENTRO). Así la
      // acción principal está siempre en la primera columna, que es la
      // que se ve. Es la lección de COT-1 ronda 4.
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
      header: t.columns.campaign,
      render: (r) => (r.campaignName ? r.campaignName : <CeldaVacia texto={t.noCampaign} />),
    },
    {
      key: "outstanding",
      header: t.columns.outstanding,
      align: "num",
      // Lo que queda por cobrar, no lo que se facturó: es la pregunta de
      // esta pantalla. Cuando no coinciden —un abono parcial, o ya
      // cobrada— la segunda línea dice de cuánto era la factura.
      //
      // Una factura cobrada no enseña «COP 0» bajo el rótulo «Por
      // cobrar»: ahí no queda una cifra que leer, así que va la frase.
      render: (r) => (
        <CellMain sub={r.outstanding === r.total ? undefined : t.ofTotal(f.money(r.total, r.currency, { mode: "full" }))}>
          {r.bucket === "pagada" ? (
            <CeldaVacia texto={t.nothingDue} />
          ) : (
            f.money(r.outstanding, r.currency, { mode: "full" })
          )}
        </CellMain>
      ),
    },
    {
      key: "dueOn",
      header: t.columns.dueOn,
      render: (r) => <span className="whitespace-nowrap">{f.date(r.dueOn)}</span>,
    },
    {
      key: "status",
      header: t.columns.status,
      render: (r) => {
        const p = pillForReceivable(r);
        return <Pill kind={p.kind}>{p.text}</Pill>;
      },
    },
    {
      key: "action",
      // FIN-2 pondrá aquí «Registrar pago» y FIN-4 «Recordar». Hasta
      // entonces el único botón es el que de verdad hace algo: abrir la
      // factura. Un botón que solo navega a una pantalla donde todavía
      // no se puede cobrar promete lo que no cumple.
      header: t.columns.action,
      render: (r) => (
        <Button size="sm" href={`/finanzas/facturas/${r.id}`}>
          {t.seeInvoice}
        </Button>
      ),
    },
  ];
};

/** El año en UTC: las fechas del repositorio son UTC y los KPI se calculan con CURRENT_DATE. */
const currentYear = () => new Date().getUTCFullYear();

/**
 * Cuántas filas se piden. Con el seed son tres; el tope está para que
 * un workspace con cientos de facturas abiertas no traiga la base
 * entera a una pantalla que no pagina. Si se alcanza, la pantalla lo
 * dice y manda al archivo, que sí tiene cursor.
 */
const PAGE_LIMIT = 200;

export default async function CuentasPorCobrarPage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string; q?: string }>;
}) {
  const params = await searchParams;
  const filter = receivableFilterKey(params.bucket);
  const q = receivablesSearchTerm(params.q);

  const { kpis, receivables } = await withWorkspace(async (tx) => ({
    kpis: await getReceivablesKpis(tx),
    receivables: await listReceivables(tx, { bucket: RECEIVABLE_FILTERS[filter].bucket, q, limit: PAGE_LIMIT }),
  }));
  // Los KPI suman facturas de todo el workspace, así que van en SU
  // moneda (workspace.currency), no en una constante. Cada fila, en
  // cambio, muestra la moneda con la que se emitió. Locale, moneda y
  // zona horaria vienen atados en el mismo formateador.
  const f = formatterFor(await getCurrentWorkspace());

  const t = MESSAGES.cobros;
  const k = t.kpis;
  const year = currentYear();
  const sinCobrosEsteAno = compareDecimal(kpis.collectedYtd, "0") === 0;

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
      <ModuleTabs active="/finanzas" />

      {/* La fila de KPI es una región con nombre: un lector de pantalla
          puede saltar a ella y no queda como cuatro cifras sueltas
          antes de la tabla. */}
      <section aria-label={k.label}>
        <KpiRow>
          <Kpi
            label={k.outstanding}
            value={f.money(kpis.outstanding, undefined, { mode: "compact" })}
            note={kpis.openCount === 0 ? k.outstandingZero : k.outstandingNote(kpis.openCount)}
          />
          <Kpi
            label={k.overdue}
            value={f.money(kpis.overdue, undefined, { mode: "compact" })}
            note={kpis.overdueCount === 0 ? k.overdueZero : k.overdueNote(kpis.overdueCount, kpis.maxDaysOverdue)}
            href={kpis.overdueCount === 0 ? undefined : receivableHref("vencida")}
          />
          <Kpi
            label={k.collected(year)}
            value={f.money(kpis.collectedYtd, undefined, { mode: "compact" })}
            // Una comparación sin base no es un 0 %: se dice con una frase
            // («Sin cobros en 2025 para comparar»), que es lo que la regla
            // del repositorio pide para una ausencia.
            delta={kpis.collectedDelta ?? undefined}
            deltaLabel={kpis.collectedDelta === null ? undefined : k.collectedVs(year - 1)}
            note={
              kpis.collectedDelta !== null
                ? undefined
                : sinCobrosEsteAno
                  ? k.collectedZero(year)
                  : k.collectedNoBase(year - 1)
            }
          />
          <Kpi
            label={k.taxReserved}
            value={f.money(kpis.taxReserved, undefined, { mode: "compact" })}
            note={kpis.taxRate ? k.taxRate(rateToPct(kpis.taxRate)) : k.taxNone}
          />
        </KpiRow>
      </section>

      <section className="mt-10" aria-labelledby="cobros">
        <SectionTitle meta={t.meta(receivables.rows.length)}>
          <span id="cobros">{t.section}</span>
        </SectionTitle>

        <Filtros active={filter} minSearch={RECEIVABLES_MIN_SEARCH} />

        <DataTable
          columns={columnas(f)}
          rows={receivables.rows}
          rowKey={(r) => r.id}
          caption={t.caption}
          emptyState={
            q !== null ? (
              <EmptyState
                title={t.emptySearch.title(q)}
                description={t.emptySearch.description}
                action={{ label: t.emptySearch.action, href: receivableHref(filter) }}
              />
            ) : filter !== "por_cobrar" ? (
              <EmptyState
                title={t.emptyFiltered.title(RECEIVABLE_FILTERS[filter].label)}
                description={t.emptyFiltered.description}
                action={{ label: t.emptyFiltered.action, href: "/finanzas" }}
              />
            ) : (
              <EmptyState
                title={t.empty.title}
                description={t.empty.description}
                action={{ label: t.empty.action, href: "/finanzas/facturas/nueva" }}
              />
            )
          }
        />

        {receivables.nextCursor !== null && (
          <p className="mt-3 text-xs text-muted">
            {t.truncated(PAGE_LIMIT)}{" "}
            <Link href="/finanzas/facturas" className="underline underline-offset-2">
              {t.truncatedLink}
            </Link>
          </p>
        )}
      </section>
    </>
  );
}
