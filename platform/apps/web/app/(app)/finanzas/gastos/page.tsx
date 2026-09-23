import type { Metadata } from "next";
import Link from "next/link";
import { proyectarGastosRecurrentes, SEMANAS_PROYECCION } from "@mc/core";
import { getExpenseMonth, listRecurringExpenses } from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { GastosPanel } from "./panel";
import { barrasProyeccion, categoriasVista, gastoVista, mesesVecinos } from "./_lib/vista";

const T = MESSAGES.gastos;

export const metadata: Metadata = { title: "Gastos · Finanzas" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/** Los dos enlaces del mes y el nombre del mes en el idioma del espacio. */
function NavegacionMes({ mes, hoy, f }: { mes: string; hoy: string; f: Formatter }) {
  const { anterior, siguiente } = mesesVecinos(mes);
  const esActual = mes === hoy.slice(0, 7);
  const enlace = "rounded-md border border-border px-2.5 py-1 text-sm text-ink-2 transition-colors hover:border-axis hover:text-ink";
  return (
    <nav aria-label="Mes de los gastos" className="flex flex-wrap items-center gap-2">
      <Link href={`/finanzas/gastos?mes=${anterior}`} className={enlace} aria-label={T.mes.anterior} rel="prev">
        <span aria-hidden="true">‹</span>
      </Link>
      <h2 className="min-w-40 text-center text-sm font-semibold text-ink first-letter:uppercase">{f.month(mes)}</h2>
      <Link href={`/finanzas/gastos?mes=${siguiente}`} className={enlace} aria-label={T.mes.siguiente} rel="next">
        <span aria-hidden="true">›</span>
      </Link>
      {esActual ? (
        <span className="text-xs text-muted">{T.mes.esteMes}</span>
      ) : (
        <Link href="/finanzas/gastos" className="text-xs text-ink underline underline-offset-4 hover:text-ink-2">
          {T.mes.volverAlActual}
        </Link>
      )}
    </nav>
  );
}

/** El desglose del GROUP BY. Ninguna de estas cifras se suma aquí. */
function PorCategoria({ filas }: { filas: { category: string; label: string; total: string; count: number }[] }) {
  if (filas.length === 0) return <p className="text-sm text-ink-2">{T.categorias.vacio}</p>;
  return (
    <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {filas.map((c) => (
        <div key={c.category} className="flex items-baseline justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2">
          <dt className="min-w-0 text-sm text-ink-2">
            <span className="block truncate">{c.label}</span>
            <span className="block text-xs text-muted">{c.count === 1 ? "1 gasto" : `${c.count} gastos`}</span>
          </dt>
          <dd className="shrink-0 font-mono text-sm tabular-nums text-ink">{c.total}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function GastosPage({ searchParams }: { searchParams: Promise<{ mes?: string }> }) {
  const params = await searchParams;
  // TODO(ACC-1): requirePermission('finanzas.gasto.ver') antes de leer.
  const { mes, recurrentes } = await withWorkspace(async (tx) => ({
    mes: await getExpenseMonth(tx, params.mes ?? null),
    recurrentes: await listRecurringExpenses(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());

  const gastos = mes.rows.map((r) => gastoVista(r, f, { sinProveedor: T.tabla.sinProveedor, sinDescripcion: T.tabla.sinDescripcion }));
  const categorias = categoriasVista(mes.byCategory, mes.currency, f);

  // La proyección la calcula core, no la pantalla; `desde` es la fecha de
  // la base, no el reloj del proceso que sirve la petición.
  const proyeccion = proyectarGastosRecurrentes(recurrentes.rows, recurrentes.today, SEMANAS_PROYECCION);
  const barras = barrasProyeccion(proyeccion, f);
  const hayProyeccion = proyeccion.currency !== null;

  return (
    <>
      <PageHeader
        eyebrow={T.header.eyebrow}
        title={T.header.title}
        description={T.header.description}
        aside={
          <Button href="/finanzas" variant="secondary">
            {T.header.volver}
          </Button>
        }
      />

      <div className="mb-6">
        <NavegacionMes mes={mes.month} hoy={mes.today} f={f} />
      </div>

      {/* Un mes sin nada que sumar no pinta tres ceros: lo explica el
          estado vacío de la tabla, como Resumen sin conexiones (RES-1). */}
      {mes.totals.count > 0 ? (
        <KpiRow>
          <Kpi
            label={T.kpis.total}
            value={f.money(mes.totals.total, mes.currency, { mode: "compact" })}
            note={`${mes.totals.count} ${mes.totals.count === 1 ? "gasto" : "gastos"}`}
          />
          <Kpi
            label={T.kpis.recurrente}
            value={f.money(mes.totals.recurring, mes.currency, { mode: "compact" })}
            note={
              mes.totals.recurringCount === 0
                ? T.kpis.sinRecurrentes
                : T.kpis.recurrenteNota(mes.totals.recurringCount)
            }
          />
          <Kpi
            label={T.kpis.deducible}
            value={f.money(mes.totals.deductible, mes.currency, { mode: "compact" })}
            note={mes.totals.deductibleCount === 0 ? T.kpis.sinDeducibles : T.kpis.deducibleNota}
          />
        </KpiRow>
      ) : (
        <p className="text-sm text-ink-2">{T.kpis.sinGastos}</p>
      )}

      <section className="mt-10" aria-labelledby="gastos-del-mes">
        <SectionTitle meta={`${f.date(mes.from)} – ${f.date(mes.to)}`}>
          <span id="gastos-del-mes">{T.cargando.section}</span>
        </SectionTitle>
        <GastosPanel
          gastos={gastos}
          currency={mes.currency}
          hoy={mes.today}
          otraMoneda={mes.otherCurrencyCount}
          esMesActual={mes.month === mes.today.slice(0, 7)}
        />
      </section>

      <section className="mt-10" aria-labelledby="por-categoria">
        <SectionTitle>
          <span id="por-categoria">{T.categorias.titulo}</span>
        </SectionTitle>
        <PorCategoria filas={categorias} />
      </section>

      <section className="mt-10">
        <ChartCard
          title={T.proyeccion.titulo}
          subtitle={T.proyeccion.subtitulo}
          chart="bar"
          labels={barras.cats}
          bar={{ axisLabels: barras.axisLabels, mode: "stack", showTotal: false }}
          series={[{ name: T.proyeccion.serie, data: barras.data, color: "warn" }]}
          ariaLabel={T.proyeccion.ariaLabel}
          // money-full en el tooltip y en «Ver tabla»: una semana con
          // 123.456,78 no se muestra como 123.457. El eje sí va compacto.
          format="money-full"
          axisFormat="compact"
          currency={proyeccion.currency ?? mes.currency}
          labelsHeader={T.proyeccion.semana}
          legend={false}
          note={
            <>
              {hayProyeccion &&
                T.proyeccion.nota(
                  f.date(proyeccion.desde),
                  f.date(proyeccion.hasta),
                  f.money(proyeccion.total, proyeccion.currency ?? mes.currency, { mode: "full" }),
                )}
              {recurrentes.otherCurrencyCount > 0 && (
                <span className="mt-1 block">{T.proyeccion.otraMoneda(recurrentes.otherCurrencyCount)}</span>
              )}
            </>
          }
          emptyState={<EmptyState title={T.proyeccion.vacioTitulo} description={T.proyeccion.vacioDescripcion} />}
        />
      </section>
    </>
  );
}
