import { Suspense } from "react";
import { getSequenceHealth, listFunnelByStep, type FunnelStep, type SequenceHealth } from "@mc/db/queries/actividad";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
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
 * El embudo por paso de una cadencia, con los números ya leídos: arriba,
 * la salud con su semáforo y cuatro cifras; debajo, la vista de flujo,
 * que ES el embudo: cada paso con sus enviados, abiertos, respondidos y
 * positivos (y la tasa de cada uno sobre lo enviado), lo que sigue en
 * cola, lo fallido y lo detenido, con una explicación por cifra.
 *
 * Hasta la ronda 4 había además un gráfico de barras agrupadas (pasos ×
 * cuatro series): con seis pasos, cada barra medía 2 o 3 px, los pasos
 * sin envíos dejaban huecos y repetía lo que el flujo ya dice con cifras.
 * Como en el flow viewer de Chief, el flujo es la pieza principal.
 */
export function MetricasCadenciaVista({
  sequenceId, health, funnel, f,
}: { sequenceId: string; health: SequenceHealth; funnel: FunnelStep[]; f: Formatter }) {
  if (funnel.length === 0) return <p className="text-sm text-fg-2">{E.sinPasos}</p>;
  const k = E.kpis;
  const pct = (r: number | null) => (r === null ? k.sinDato : f.pct(r, 1));
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
      {health.sent === 0 && <EmptyState title={E.vacio.titulo} description={E.vacio.descripcion} />}
      <FlujoCadencia pasos={pasosFlujo(funnel, f)} />
    </section>
  );
}

/** Mientras la consulta responde: el título, cuatro cifras y tres pasos del flujo en gris. */
function MetricasCadenciaEsqueleto() {
  return (
    <div aria-busy="true" aria-label={E.cargando} className="flex flex-col gap-4">
      <span className="block h-5 w-48 animate-pulse rounded-sm bg-hover" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <span key={i} className="block h-16 animate-pulse rounded-md bg-hover" />)}
      </div>
      {[0, 1, 2].map((i) => <span key={i} className="block h-20 animate-pulse rounded-md bg-hover" />)}
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
