import { getResumenKpis, type KpiSeries } from "@mc/db/queries/resumen";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";
import type { Filtro } from "./_lib/filtro";

/**
 * La fila de KPIs: cuatro cifras, cada una con su variación contra el
 * periodo anterior y una sparkline de doce puntos.
 *
 * Aquí no se calcula nada: `getResumenKpis` devuelve el valor, el
 * anterior, la variación, la serie y sobre cuántos videos se calculó,
 * todo resuelto en SQL. Este archivo solo elige qué formato le toca a
 * cada número y qué nota lo acompaña.
 */

/** Una sparkline de un punto no dice nada; el kit la dibujaría plana. */
function spark(serie: KpiSeries): number[] | undefined {
  return serie.spark.length > 1 ? serie.spark : undefined;
}

/**
 * Lo que va debajo de la cifra: el delta si existe y, si no, por qué no
 * existe. Las CUATRO tarjetas pasan por aquí a propósito: si unas
 * explican la ausencia de flecha y otras la omiten, quien mira no puede
 * distinguir «no hay con qué comparar» de «no cambió».
 *
 * Cuando la tarjeta ya trae nota propia, las dos frases se componen en
 * vez de pisarse. Sin cifra no hay comparación que explicar: queda solo
 * la nota, que es la que dice por qué no hay cifra.
 */
function comparacion(serie: KpiSeries, label: string, note?: string) {
  if (serie.value === null) return { note };
  if (serie.delta === null) {
    return { note: [note, MESSAGES.kpis.sinComparacion].filter(Boolean).join(" · ") };
  }
  return { delta: serie.delta, deltaLabel: label, note };
}

function valor(serie: KpiSeries, formatear: (v: number) => string): string {
  return serie.value === null ? MESSAGES.kpis.sinDato : formatear(serie.value);
}

/** «Sobre 12 videos, en su vida completa»: la base real de una razón. */
function base(serie: KpiSeries, f: Formatter): string | undefined {
  if (serie.value === null || serie.sample === undefined) return undefined;
  return MESSAGES.kpis.base(serie.sample, f.int(serie.sample));
}

export async function Kpis({ filtro }: { filtro: Filtro }) {
  const [kpis, ws] = await Promise.all([
    withWorkspace((tx) => getResumenKpis(tx, filtro)),
    getCurrentWorkspace(),
  ]);
  const f: Formatter = formatterFor(ws);
  const t = MESSAGES.kpis;

  return (
    <KpiRow>
      <Kpi
        label={filtro.platform ? t.followers.labelRed(PLATFORM_LABEL[filtro.platform]) : t.followers.label}
        value={valor(kpis.followers, (v) => f.compact(v))}
        sparkline={spark(kpis.followers)}
        {...comparacion(
          kpis.followers,
          t.deltaLabelPunto(filtro.days),
          kpis.hasAccountSeries ? undefined : t.followers.sinCuenta,
        )}
      />
      <Kpi
        label={t.views.label(filtro.days)}
        value={valor(kpis.views, (v) => f.compact(v))}
        sparkline={spark(kpis.views)}
        // Esta cifra cuenta otra cosa que las dos de al lado —o la
        // cuenta entera, o solo lo publicado si no hay cuenta— y hay que
        // decir cuál de las dos.
        {...comparacion(
          kpis.views,
          t.deltaLabel(filtro.days),
          kpis.viewsSource === "content" ? t.views.noteContenido(kpis.posts, f.int(kpis.posts)) : t.views.note,
        )}
      />
      <Kpi
        label={t.nonFollowerReach.label}
        value={valor(kpis.nonFollowerReach, (v) => f.pct(v))}
        sparkline={spark(kpis.nonFollowerReach)}
        {...comparacion(kpis.nonFollowerReach, t.deltaLabel(filtro.days), base(kpis.nonFollowerReach, f))}
      />
      <Kpi
        label={t.savesPer1k.label}
        value={valor(kpis.savesPer1k, (v) => f.compact(v))}
        sparkline={spark(kpis.savesPer1k)}
        {...comparacion(kpis.savesPer1k, t.deltaLabel(filtro.days), base(kpis.savesPer1k, f))}
      />
    </KpiRow>
  );
}

/** El mismo tamaño mientras la base responde. */
export function KpisEsqueleto() {
  return (
    <KpiRow>
      {MESSAGES.loading.kpis.map((label) => (
        <Kpi key={label} label={label} value="" loading />
      ))}
    </KpiRow>
  );
}
