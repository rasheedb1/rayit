import type { Metadata } from "next";
import { esMesEntero, proyeccionDePlataformas } from "@mc/core";
import {
  getPlatformPayoutKpis,
  getPlatformPayoutMonths,
  listPlatformPayouts,
  type PlatformPayoutRow,
} from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { requireModuleAccess, requirePagePermission } from "@/lib/permisos/modulo";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { MESSAGES as MESSAGES_FINANZAS } from "../_lib/messages";
import { MESSAGES } from "./_lib/messages";

export const metadata: Metadata = { title: "Ingresos de plataformas" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const T = MESSAGES;
/** El texto de la fila lo pone el módulo, para que las dos pantallas la nombren igual. */
const FLUJO = MESSAGES_FINANZAS.flujo;

/**
 * Las columnas se construyen con el formateador del workspace, nunca
 * con el de por defecto: un espacio en MXN/en-US ve sus cifras y sus
 * meses en su locale.
 */
const columnas = (f: Formatter): Column<PlatformPayoutRow>[] => [
  {
    key: "month",
    header: T.tabla.columnas.mes,
    // El periodo exacto solo se enseña cuando NO es el mes entero (un
    // rango escrito a mano o traído por el formato genérico). En un pago
    // mensual —que es la norma— repetirlo era una cuarta columna que a
    // 390 px cortaba la cifra, que es justo lo que se viene a ver.
    render: (r) => (
      <CellMain sub={esMesEntero(r.periodStart, r.periodEnd) ? T.origen[r.source] : f.dateRange(r.periodStart, r.periodEnd)}>
        {f.month(r.month)}
      </CellMain>
    ),
  },
  {
    key: "platform",
    header: T.tabla.columnas.plataforma,
    render: (r) => <PlatformPill platformId={r.platformId} />,
  },
  {
    key: "amount",
    header: T.tabla.columnas.monto,
    align: "num",
    render: (r) => f.money(r.amount, r.currency, { mode: "full" }),
  },
];

/**
 * Lo que de aquí entra al flujo de caja de FIN-6, con la MISMA cifra:
 * las dos pantallas llaman a `proyeccionDePlataformas` de @mc/core, que
 * es donde está probada. Se enseña aquí porque quien acaba de cargar un
 * CSV quiere ver el efecto sin cambiar de pantalla, y porque una cifra
 * estimada tiene que decir de dónde sale allí donde se carga su fuente.
 */
function EntradaAlFlujo({
  proyeccion,
  f,
}: {
  proyeccion: ReturnType<typeof proyeccionDePlataformas>;
  f: Formatter;
}) {
  const base =
    proyeccion.mesesPromediados === proyeccion.ventana
      ? T.flujo.base
      : T.flujo.baseParcial(proyeccion.mesesPromediados);
  return (
    <section className="mt-10" aria-labelledby="flujo">
      <SectionTitle>
        <span id="flujo">{T.flujo.titulo}</span>
      </SectionTitle>
      <div className="rounded-md border border-border bg-surface p-4">
        {proyeccion.estimado === null ? (
          <p className="text-sm leading-5 text-ink-2">{T.flujo.sinDatos}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm font-medium text-ink">{FLUJO.otrosIngresos.fila}</span>
              <span className="font-mono text-lg font-medium tabular-nums text-ink">
                {f.money(proyeccion.estimado, proyeccion.currency, { mode: "full" })}
                <span className="ml-1 text-xs font-normal text-muted">/ mes</span>
              </span>
              <span className="w-full text-xs text-muted">{base}</span>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-xs leading-4 text-muted">{T.flujo.comoEntra}</p>
          </>
        )}
        <div className="mt-3">
          <Button size="sm" href="/finanzas/flujo">
            {T.flujo.verFlujo}
          </Button>
        </div>
      </div>
    </section>
  );
}

export default async function IngresosPage() {
  // Primero el permiso, antes de leer nada. Lo que paga una plataforma
  // es dinero del espacio y va al mismo sitio que el flujo de caja, así
  // que se mira con `finanzas.flujo.ver`: el rol Mánager NO lo ve
  // (decisión E de la propuesta ACC). No hay un `finanzas.ingreso.ver`
  // porque el catálogo viaja en la semilla de la migración 0034, que ya
  // está aplicada; está propuesto en docs/propuestas/FIN-7.md §1.
  // Sin él, 404 como el resto del módulo (ACC-5), y la pestaña no se pinta.
  await requireModuleAccess("finanzas");
  await requirePagePermission("finanzas.flujo.ver");
  const { kpis, pagos, meses } = await withWorkspace(async (tx) => ({
    kpis: await getPlatformPayoutKpis(tx),
    pagos: await listPlatformPayouts(tx, { limit: 200 }),
    meses: await getPlatformPayoutMonths(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const permisos = await permisosDeLaSesion();

  // El promedio lo calcula @mc/core, no la pantalla. `hoy` sale de la
  // base (CURRENT_DATE) y no del reloj de Node: la ventana de meses
  // tiene que ser la misma que la de las consultas.
  const proyeccion = proyeccionDePlataformas(meses, { hoy: kpis.today, currency: kpis.currency });
  const anio = Number(kpis.today.slice(0, 4));

  return (
    <>
      <PageHeader
        eyebrow={T.eyebrow}
        title={T.title}
        description={T.description}
        aside={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" href="/finanzas/ingresos/importar">
              {T.acciones.importar}
            </Button>
            <Button href="/finanzas/ingresos/nuevo">{T.acciones.aMano}</Button>
          </div>
        }
      />
      <ModuleTabs active="/finanzas/ingresos" permisos={permisos} />

      <KpiRow>
        <Kpi
          label={T.kpis.ytd(anio)}
          value={f.money(kpis.ytd, kpis.currency, { mode: "compact" })}
          note={kpis.ytdPayouts === 0 ? T.kpis.ytdVacio : T.kpis.ytdNota(kpis.ytdPayouts)}
        />
        <Kpi
          label={T.kpis.ultimoMes}
          // Un mes sin pago no vale cero: se dice con una frase y el
          // mes va en la nota, para que se sepa de cuál se habla.
          value={kpis.lastMonth === null ? "Sin pagos" : f.money(kpis.lastMonth, kpis.currency, { mode: "compact" })}
          note={kpis.lastMonth === null ? T.kpis.ultimoMesVacio : f.month(kpis.lastMonthLabel)}
        />
        <Kpi
          label={T.kpis.estimado}
          value={
            proyeccion.estimado === null
              ? "Sin estimar"
              : f.money(proyeccion.estimado, proyeccion.currency, { mode: "compact" })
          }
          note={
            proyeccion.estimado === null
              ? T.kpis.estimadoVacio
              : T.kpis.estimadoNota(proyeccion.ventana, proyeccion.mesesPromediados)
          }
        />
      </KpiRow>

      <EntradaAlFlujo proyeccion={proyeccion} f={f} />

      <section className="mt-10" aria-labelledby="pagos">
        <SectionTitle meta={T.tabla.meta(pagos.rows.length)}>
          <span id="pagos">{T.loading.section}</span>
        </SectionTitle>
        <DataTable
          columns={columnas(f)}
          rows={pagos.rows}
          rowKey={(r) => r.id}
          caption={T.tabla.caption}
          emptyState={
            <EmptyState
              title={T.vacio.title}
              description={T.vacio.description}
              action={{ label: T.vacio.accion, href: "/finanzas/ingresos/importar" }}
            />
          }
        />
      </section>
    </>
  );
}
