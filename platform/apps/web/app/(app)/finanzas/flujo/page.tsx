import type { Metadata } from "next";
import { addDecimal, projectCashflow, toCents, type Cashflow, type CobroDeLaSemana, type Decimal, type SemanaFlujo } from "@mc/core";
import { getCashflowInputs } from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/ui/chart-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";

export const metadata: Metadata = { title: "Flujo de caja" };
// Lee la base en cada petición: una proyección de hoy no se prerenderiza.
export const dynamic = "force-dynamic";

const T = MESSAGES.flujo;

/**
 * Lo que la barra «Gastos e impuestos» enseña: los dos egresos juntos,
 * como el mock. La tabla los separa en dos columnas. La suma la hace
 * `addDecimal` (centavos en BigInt) y no `Number(a) + Number(b)`:
 * aunque el resultado acabe en píxeles, sumar dinero en coma flotante
 * en esta capa es exactamente la costumbre que el repo no quiere.
 */
function egresosDe(s: SemanaFlujo): Decimal {
  return addDecimal(s.gastos, s.impuestos);
}

/**
 * Las cifras cruzan a los gráficos como `number` porque eso es lo que
 * el kit dibuja (`Series.data: number[]`): son píxeles, no dinero. El
 * dinero que se LEE —KPIs, tabla, tooltip— sale siempre del string
 * decimal que devolvió core, formateado con el formateador del espacio.
 */
function paraElGrafico(c: Cashflow) {
  return {
    labels: c.semanas.map((s) => s.inicio),
    series: [
      { name: T.grafico.cobros, data: c.semanas.map((s) => Number(s.cobros)), color: "accent" as const },
      { name: T.grafico.egresos, data: c.semanas.map((s) => Number(egresosDe(s))), color: "deemph" as const },
    ],
  };
}

/**
 * El detalle de una semana: qué factura y qué negocio la componen. Va
 * DENTRO de la celda de la semana y no en una columna propia: a 400 px
 * una séptima columna empujaba el acumulado —la cifra que más importa—
 * fuera de la pantalla, y `DataTable` no tiene filas expandibles
 * (cambiarle la API pide un PR aparte, components/ui/README.md).
 * `<details>` nativo: sin JavaScript, sin estado y accesible por
 * teclado.
 */
function Detalle({ cobros, f }: { cobros: CobroDeLaSemana[]; f: Formatter }) {
  if (cobros.length === 0) return <span className="block text-xs text-fg-3">{T.tabla.sinCobros}</span>;
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer list-none text-xs text-fg-2 underline decoration-line underline-offset-2 hover:text-fg">
        {T.tabla.verDetalle(cobros.length)}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {cobros.map((c) => (
          <li key={`${c.kind}-${c.id}`} className="text-xs leading-4">
            <span className="text-fg">{c.label}</span>
            <span className="text-fg-3"> · {c.companyName}</span>
            <br />
            <span className="font-mono tabular-nums text-fg-2">{f.money(c.amount, undefined, { mode: "full" })}</span>
            <span className="text-fg-3"> · {f.date(c.esperadoEl)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const columnas = (f: Formatter): Column<SemanaFlujo>[] => [
  {
    key: "semana",
    header: T.tabla.semana,
    // Ancho fijo: sin él, a 400 px la columna se encoge hasta partir
    // «21–27 sep» en dos líneas y «Sin cobros previstos» en tres.
    width: "11rem",
    render: (s) => (
      // No es `CellMain`: su `sub` envuelve el contenido en un <span>, y
      // un <details> dentro de un <span> no es HTML válido.
      <span className="block min-w-0">
        <span className="block whitespace-nowrap font-medium text-ink">{f.dateRange(s.inicio, s.fin)}</span>
        <Detalle cobros={s.detalle} f={f} />
      </span>
    ),
  },
  { key: "cobros", header: T.tabla.cobros, align: "num", render: (s) => f.money(s.cobros, undefined, { mode: "full" }) },
  { key: "gastos", header: T.tabla.gastos, align: "num", render: (s) => f.money(s.gastos, undefined, { mode: "full" }) },
  { key: "impuestos", header: T.tabla.impuestos, align: "num", render: (s) => f.money(s.impuestos, undefined, { mode: "full" }) },
  {
    key: "neto",
    header: T.tabla.neto,
    align: "num",
    render: (s) => <span className={toCents(s.neto) < 0n ? "text-bad" : ""}>{f.money(s.neto, undefined, { mode: "full" })}</span>,
  },
  {
    key: "acumulado",
    header: T.tabla.acumulado,
    align: "num",
    render: (s) => <span className={toCents(s.acumulado) < 0n ? "text-bad" : ""}>{f.money(s.acumulado, undefined, { mode: "full" })}</span>,
  },
];

/**
 * Lo que quedó fuera de la proyección, cada cosa con su frase. Una
 * ausencia se explica; no se pinta un cero ni un guion mudo.
 */
function Excluidos({ c, f }: { c: Cashflow; f: Formatter }) {
  const e = c.excluidos;
  const frases: string[] = [];
  if (e.vencidas.count > 0) {
    frases.push(
      `No contamos ${e.vencidas.count} ${e.vencidas.count === 1 ? "factura vencida" : "facturas vencidas"} por ` +
        `${f.money(e.vencidas.amount, undefined, { mode: "full" })}: se esperan, pero no se prometen.`,
    );
  }
  if (e.yaFacturados.count > 0) {
    frases.push(
      `${e.yaFacturados.count} ${e.yaFacturados.count === 1 ? "negocio ganado ya tiene" : "negocios ganados ya tienen"} ` +
        "su factura, y esa es la que cuenta: sumarlos sería contarlos dos veces.",
    );
  }
  if (e.sinFecha.count > 0) {
    frases.push(
      `Sin fecha de cierre: ${e.sinFecha.count} ${e.sinFecha.count === 1 ? "negocio" : "negocios"} por ` +
        `${f.money(e.sinFecha.amount, undefined, { mode: "full" })}. Ponles una fecha esperada y entran solos.`,
    );
  }
  if (e.fueraDeVentana.count > 0) {
    frases.push(
      `${e.fueraDeVentana.count} ${e.fueraDeVentana.count === 1 ? "cobro cae" : "cobros caen"} fuera de estas ocho semanas, ` +
        `por ${f.money(e.fueraDeVentana.amount, undefined, { mode: "full" })}.`,
    );
  }
  if (e.otraMoneda.count > 0) {
    frases.push(
      `${e.otraMoneda.count} ${e.otraMoneda.count === 1 ? "registro viene" : "registros vienen"} en ` +
        `${e.otraMoneda.monedas.join(" y ")} y no en ${f.currency}: todavía no convertimos monedas.`,
    );
  }
  if (frases.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs leading-5 text-fg-2">
      {frases.map((frase) => (
        <li key={frase}>{frase}</li>
      ))}
    </ul>
  );
}

export default async function FlujoPage() {
  // TODO(ACC-1): finanzas.flujo.ver — cuando ACC-1 y ACC-5 estén en
  // main, esta línea es `await requirePermission("finanzas.flujo.ver")`
  // y el rol Mánager recibe 404 aquí (docs/propuestas/FIN-6.md §0.4).
  const entradas = await withWorkspace((tx) => getCashflowInputs(tx));
  const c = projectCashflow(entradas);
  const f = formatterFor(await getCurrentWorkspace());

  const cabecera = (
    <PageHeader
      eyebrow={T.eyebrow}
      title={T.title}
      description={T.description}
      aside={<Button href="/finanzas">{T.volver}</Button>}
    />
  );

  if (c.vacio) {
    return (
      <>
        {cabecera}
        <EmptyState
          title={T.vacio.title}
          description={T.vacio.description}
          action={{ label: T.vacio.accion, href: "/finanzas/facturas/nueva" }}
        />
        <Excluidos c={c} f={f} />
      </>
    );
  }

  const grafico = paraElGrafico(c);
  const ajustada = c.semanaMasAjustada;
  const nota =
    `Los gastos son el ritmo de los recurrentes del último mes (${f.money(c.gastoMensual, undefined, { mode: "full" })}) ` +
    `repartido por semana: ${f.money(c.gastoSemanal, undefined, { mode: "full" })}. ` +
    (entradas.reservaPct === null
      ? "Todavía no hay un porcentaje de reserva de impuestos configurado, así que no apartamos nada."
      : `Los impuestos son el ${entradas.reservaPct} % de los cobros de cada semana.`);

  return (
    <>
      {cabecera}

      <KpiRow className="lg:grid-cols-2">
        <Kpi
          label={T.kpis.proyectado}
          value={f.money(c.proyectado, undefined, { mode: "compact" })}
          note={`Del ${f.date(c.semanas[0]!.inicio)} al ${f.date(c.semanas[c.semanas.length - 1]!.fin)}`}
        />
        <Kpi
          label={T.kpis.ajustada}
          value={ajustada ? f.dateRange(ajustada.inicio, ajustada.fin) : "—"}
          note={ajustada ? `Cierra en ${f.money(ajustada.acumulado, undefined, { mode: "full" })}` : T.kpis.sinAjustada}
        />
      </KpiRow>

      <section className="mt-10" aria-labelledby="grafico">
        <ChartCard
          title={T.grafico.title}
          subtitle={T.grafico.subtitle}
          chart="bar"
          bar={{ mode: "group", axisLabels: c.semanas.map((s) => f.dayMonth(s.inicio)) }}
          series={grafico.series}
          labels={grafico.labels.map((inicio, i) => f.dateRange(inicio, c.semanas[i]!.fin))}
          labelsHeader={T.tabla.semana}
          format="money"
          axisFormat="compact"
          currency={f.currency}
          ariaLabel={T.grafico.aria}
          note={nota}
        />
      </section>

      <section className="mt-10" aria-labelledby="semanas">
        <SectionTitle meta={`${c.semanas.length} semanas`}>
          <span id="semanas">{T.tabla.seccion}</span>
        </SectionTitle>
        <DataTable
          columns={columnas(f)}
          rows={c.semanas}
          rowKey={(s) => s.inicio}
          caption={T.tabla.caption}
          emptyState={<EmptyState title={T.vacio.title} description={T.vacio.description} />}
        />
        <Excluidos c={c} f={f} />
      </section>
    </>
  );
}
