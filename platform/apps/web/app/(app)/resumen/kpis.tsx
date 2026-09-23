import { getResumenKpis, type KpiSeries } from "@mc/db/queries/resumen";
import { Kpi, KpiRow, trendOf, type KpiProps } from "@/components/ui/kpi";
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
 * Cuando la tarjeta ya trae nota propia, las frases se componen en vez
 * de pisarse. Sin cifra no hay comparación que explicar: queda solo la
 * nota, que es la que dice por qué no hay cifra.
 *
 * Un delta en PUNTOS (el alcance en no seguidores, que ya es un
 * porcentaje) se escribe «+2,1 puntos» y no «+4 %»: la variación
 * relativa de un porcentaje se leía como puntos. La flecha usa el mismo
 * redondeo que el texto (una cifra decimal), así que no se contradicen.
 *
 * Las cuentas nuevas se dicen: suman en la cifra y no en la comparación.
 */
function comparacion(
  serie: KpiSeries,
  label: string,
  f: Formatter,
  ...notas: (string | undefined)[]
): Pick<KpiProps, "delta" | "deltaLabel" | "deltaText" | "trend" | "note"> {
  const t = MESSAGES.kpis;
  const nuevas = serie.value !== null && serie.newAccounts ? t.nuevas(serie.newAccounts, f.int(serie.newAccounts)) : undefined;
  const juntar = (...partes: (string | undefined)[]) => partes.filter(Boolean).join(" · ") || undefined;
  if (serie.value === null) return { note: juntar(...notas) };
  if (serie.delta === null) return { note: juntar(...notas, nuevas, t.sinComparacion) };
  const note = juntar(...notas, nuevas);
  if (serie.deltaKind === "points") {
    return {
      delta: serie.delta,
      deltaText: t.puntos(f.points(serie.delta, 1)),
      trend: trendOf(serie.delta, undefined, 1),
      deltaLabel: label,
      note,
    };
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
          f,
          kpis.hasAccountSeries ? undefined : t.followers.sinCuenta,
        )}
      />
      <Kpi
        label={t.views.label(filtro.days)}
        value={valor(kpis.views, (v) => f.compact(v))}
        sparkline={spark(kpis.views)}
        // Esta cifra cuenta otra cosa que las dos de al lado —o la
        // cuenta entera, o solo lo publicado si no hay cuenta— y hay que
        // decir cuál de las dos. Y si la cuenta aún no cerró el último
        // día del reloj, hasta cuándo suma.
        {...comparacion(
          kpis.views,
          t.deltaLabel(filtro.days),
          f,
          kpis.viewsSource === "content" ? t.views.noteContenido(kpis.posts, f.int(kpis.posts)) : t.views.note,
          kpis.viewsWindow && kpis.end && kpis.viewsWindow.end !== kpis.end
            ? t.views.hastaCuenta(f.date(kpis.viewsWindow.end))
            : undefined,
        )}
      />
      <Kpi
        label={t.nonFollowerReach.label}
        value={valor(kpis.nonFollowerReach, (v) => f.pct(v))}
        sparkline={spark(kpis.nonFollowerReach)}
        {...comparacion(kpis.nonFollowerReach, t.deltaLabel(filtro.days), f, base(kpis.nonFollowerReach, f))}
      />
      <Kpi
        label={t.savesPer1k.label}
        value={valor(kpis.savesPer1k, (v) => f.compact(v))}
        sparkline={spark(kpis.savesPer1k)}
        {...comparacion(kpis.savesPer1k, t.deltaLabel(filtro.days), f, base(kpis.savesPer1k, f))}
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
