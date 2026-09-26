import { Suspense } from "react";
import { getSequenceHealth, listFunnelByStep, type FunnelStep, type SequenceHealth } from "@mc/db/queries/actividad";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/ui/chart-card";
import type { Series } from "@/components/ui/chart-utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { esperaEntre, etiquetaTipo } from "../../cadencias/_lib/vista";
import { IconoCanal } from "../../cadencias/canal";
import { hrefDe, SALUD_PILL } from "../_lib/vista";
import { MESSAGES } from "../messages";
import { FlujoCadencia, type CifraFlujo, type PasoFlujo } from "./flujo-cadencia";
import { FronteraWidget } from "./frontera-widget";

const E = MESSAGES.embudo;
const F = MESSAGES.flujo;

/**
 * Las cuatro series del embudo, en su orden: cada una cabe dentro de la
 * anterior. Colores categóricos del kit (los de DEFAULT_ORDER de
 * chart-utils) salvo «Positivos», el único que es bueno por definición:
 * «Respondidos» no va en ámbar, que en esta app es alerta.
 */
export const SERIES_EMBUDO = [
  { key: "sent", color: "deemph" },
  { key: "opened", color: "accent" },
  { key: "replied", color: "tiktok" },
  { key: "positive", color: "good" },
] as const satisfies ReadonlyArray<{ key: keyof typeof E.series; color: Series["color"] }>;

/**
 * Las cifras de un paso para la vista de flujo, cada una con su
 * explicación (en plural o en singular según la cifra, con la cifra
 * formateada en el idioma del espacio) y, si aplica, su tasa.
 */
function cifrasDe(s: FunnelStep, f: Formatter): CifraFlujo[] {
  const x = F.explica;
  const tasa = (r: number | null) => (r === null ? null : F.tasa(f.pct(r)));
  const c = (key: keyof typeof F.cifras, n: number, explica: string, extra: Partial<CifraFlujo> = {}): CifraFlujo => ({
    key, valor: f.int(n), etiqueta: F.cifras[key], explica, tasa: null, tono: n === 0 ? "muted" : "fg", ...extra,
  });
  const dice = (frase: (n: string, count: number) => string, n: number) => frase(f.int(n), n);
  return [
    c("sent", s.sent, dice(x.sent, s.sent)),
    s.opensTracked
      ? c("opened", s.opened, dice(x.opened, s.opened), { tasa: tasa(s.openRate) })
      : c("opened", 0, x.openedNoTracked, { valor: E.kpis.sinDato, tono: "muted" }),
    c("replied", s.replied, dice(x.replied, s.replied), { tasa: tasa(s.replyRate) }),
    c("positive", s.positive, dice(x.positive, s.positive), { tasa: tasa(s.positiveRate), tono: s.positive > 0 ? "good" : "muted" }),
    c("pending", s.pending, dice(x.pending, s.pending)),
    c("failed", s.failed, dice(x.failed, s.failed), { tono: s.failed > 0 ? "bad" : "muted" }),
    c("stopped", s.stopped, dice(x.stopped, s.stopped)),
  ];
}

export function pasosFlujo(funnel: FunnelStep[], f: Formatter): PasoFlujo[] {
  return funnel.map((s, i) => ({
    id: s.stepId,
    titulo: F.paso(f.int(s.position), f.int(s.dayOffset), etiquetaTipo(s.stepType)),
    espera: esperaEntre(funnel[i - 1], s, f),
    icono: <IconoCanal canal={s.channel} tipo={s.stepType} size={13} />,
    cifras: cifrasDe(s, f),
  }));
}

/**
 * El embudo por paso y la vista de flujo de una cadencia, con los números
 * ya leídos: arriba, la salud con su semáforo y cuatro cifras; después, el
 * gráfico de barras por paso (con su tabla) y el flujo con una
 * explicación por cifra.
 */
export function MetricasCadenciaVista({
  sequenceId, health, funnel, f,
}: { sequenceId: string; health: SequenceHealth; funnel: FunnelStep[]; f: Formatter }) {
  if (funnel.length === 0) return <p className="text-sm text-fg-2">{E.sinPasos}</p>;
  const k = E.kpis;
  const pct = (r: number | null) => (r === null ? k.sinDato : f.pct(r, 1));
  const series: Series[] = SERIES_EMBUDO.map((s) => ({ name: E.series[s.key], color: s.color, data: funnel.map((p) => p[s.key]) }));
  const actividad = hrefDe({ vista: "queue", cadencia: sequenceId, tipo: null, contacto: null });
  return (
    <section aria-labelledby="resultados-cadencia" className="flex flex-col gap-4">
      <SectionTitle
        meta={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Pill kind={SALUD_PILL[health.health]}>{E.salud[health.health]}</Pill>
            <Button size="sm" variant="ghost" href={actividad}>{E.verCola}</Button>
          </span>
        }
      >
        <span id="resultados-cadencia">{E.titulo}</span>
      </SectionTitle>
      <p className="-mt-2 max-w-2xl text-xs text-fg-2">
        {E.saludAyuda[health.health]} {E.descripcion}
      </p>
      <KpiRow>
        <Kpi label={k.enviados} value={f.int(health.sent)} note={k.enviadosNota(f.int(health.sent7d))} />
        <Kpi
          label={k.respuesta}
          value={pct(health.replyRate)}
          note={health.sent > 0 ? k.respuestaNota(f.int(health.replied), f.int(health.sent)) : k.sinDatoNota}
        />
        <Kpi label={k.positivos} value={f.int(health.positive)} note={k.positivosNota(pct(health.positiveRate))} />
        <Kpi label={k.fallidos} value={f.int(health.failed)} note={k.fallidosNota(f.int(health.failed7d))} />
      </KpiRow>
      {health.sent === 0 ? (
        <EmptyState title={E.vacio.titulo} description={E.vacio.descripcion} />
      ) : (
        <ChartCard
          title={E.grafico}
          chart="bar"
          bar={{ mode: "group", axisLabels: funnel.map((s) => E.eje(f.int(s.position))) }}
          series={series}
          labels={funnel.map((s) => F.paso(f.int(s.position), f.int(s.dayOffset), etiquetaTipo(s.stepType)))}
          labelsHeader={E.columnaPaso}
          format="int"
          ariaLabel={E.grafico}
        />
      )}
      <FlujoCadencia pasos={pasosFlujo(funnel, f)} />
    </section>
  );
}

/** Mientras la consulta responde: el título, cuatro cifras y el flujo en gris. */
function MetricasCadenciaEsqueleto() {
  return (
    <div aria-busy="true" aria-label={E.cargando} className="flex flex-col gap-4">
      <span className="block h-5 w-48 animate-pulse rounded-sm bg-hover" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <span key={i} className="block h-16 animate-pulse rounded-md bg-hover" />)}
      </div>
      <span className="block h-40 animate-pulse rounded-md bg-hover" />
    </div>
  );
}

async function MetricasCadenciaDatos({ sequenceId }: { sequenceId: string }) {
  const datos = await withWorkspace(async (tx) => ({
    health: await getSequenceHealth(tx, sequenceId),
    funnel: await listFunnelByStep(tx, sequenceId),
  }));
  if (!datos.health) return null;
  const f = formatterFor(await getCurrentWorkspace());
  return <MetricasCadenciaVista sequenceId={sequenceId} health={datos.health} funnel={datos.funnel} f={f} />;
}

/**
 * Montable con una línea en /ventas/cadencias/[id]
 * (`<MetricasCadencia sequenceId={id} />`): lee el embudo
 * (outbound_funnel_by_step) y la salud (outbound_sequence_health) de la
 * cadencia con la RLS del espacio y los formatea en su idioma. Si la
 * cadencia no es del espacio, no pinta nada.
 *
 * Trae su Suspense y su frontera de error: el detalle de la cadencia se
 * pinta sin esperar a estas cifras, y si su consulta falla cae solo esta
 * sección, con un aviso.
 */
export function MetricasCadencia({ sequenceId }: { sequenceId: string }) {
  return (
    <FronteraWidget aviso={E.error}>
      <Suspense fallback={<MetricasCadenciaEsqueleto />}>
        <MetricasCadenciaDatos sequenceId={sequenceId} />
      </Suspense>
    </FronteraWidget>
  );
}
