import { getResumenKpis, type KpiSeries } from "@mc/db/queries/resumen";
import { Kpi, KpiRow, trendOf, type KpiProps } from "@/components/ui/kpi";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { KpiConInfo } from "./kpi-con-info";
import { MESSAGES } from "./messages";
import type { Filtro } from "./_lib/filtro";

/**
 * La fila de KPIs: cuatro cifras, cada una con su variación contra el
 * periodo anterior y una sparkline de doce puntos.
 *
 * Aquí no se calcula nada: `getResumenKpis` devuelve el valor, el
 * anterior, la variación, la serie y sobre cuántos videos se calculó,
 * todo resuelto en SQL. Este archivo solo elige qué formato le toca a
 * cada número y qué se explica.
 *
 * En la tarjeta va SOLO el dato: cifra, delta y sparkline. Lo que
 * explica de dónde sale —la base de videos, las cuentas nuevas, hasta
 * qué día suma la cuenta— va detrás del botón (i) (`KpiConInfo`). A
 * 400 px, dos o tres líneas de nota bajo cada delta alargaban las
 * cuatro tarjetas y la pantalla explicaba más de lo que enseñaba.
 */

/** Una sparkline de un punto no dice nada; el kit la dibujaría plana. */
function spark(serie: KpiSeries): number[] | undefined {
  return serie.spark.length > 1 ? serie.spark : undefined;
}

/**
 * Lo que va debajo de la cifra: el delta si existe y, si no, UNA línea
 * corta que dice por qué no existe. Las CUATRO tarjetas pasan por aquí a
 * propósito: si unas explican la ausencia de flecha y otras la omiten,
 * quien mira no puede distinguir «no hay con qué comparar» de «no
 * cambió».
 *
 * Sin cifra no hay comparación que explicar: queda solo `sinCifra`, que
 * es la que dice por qué no hay cifra (o nada, y la tarjeta enseña «—»).
 *
 * Con periodo anterior pero pocos videos (`lowSample`), la variación no
 * se pinta y se dice «Pocos videos para comparar»: una flecha roja de
 * «−50 %» sobre un video es ruido que alarma.
 *
 * Un delta en PUNTOS (el alcance en no seguidores, que ya es un
 * porcentaje) se escribe «+2,1 puntos» y no «+4 %»: la variación
 * relativa de un porcentaje se leía como puntos. La flecha usa el mismo
 * redondeo que el texto (una cifra decimal), así que no se contradicen.
 */
function comparacion(
  serie: KpiSeries,
  label: string,
  f: Formatter,
  sinCifra?: string,
): Pick<KpiProps, "delta" | "deltaLabel" | "deltaText" | "trend" | "note"> {
  const t = MESSAGES.kpis;
  if (serie.value === null) return { note: sinCifra };
  if (serie.delta === null) return { note: serie.lowSample ? t.pocaMuestra : t.sinComparacion };
  if (serie.deltaKind === "points") {
    return {
      delta: serie.delta,
      deltaText: t.puntos(f.points(serie.delta, 1)),
      trend: trendOf(serie.delta, undefined, 1),
      deltaLabel: label,
    };
  }
  return { delta: serie.delta, deltaLabel: label };
}

function valor(serie: KpiSeries, formatear: (v: number) => string): string {
  return serie.value === null ? MESSAGES.kpis.sinDato : formatear(serie.value);
}

/** Las frases del (i): sin las vacías, y sin repetir. */
function info(...frases: (string | false | null | undefined)[]): string[] {
  return [...new Set(frases.filter((x): x is string => Boolean(x)))];
}

export async function Kpis({ filtro }: { filtro: Filtro }) {
  const [kpis, ws] = await Promise.all([
    withWorkspace((tx) => getResumenKpis(tx, filtro)),
    getCurrentWorkspace(),
  ]);
  const f: Formatter = formatterFor(ws);
  const t = MESSAGES.kpis;
  const ti = t.info;

  /** «2 cuentas conectadas dentro del periodo…», solo si hay cifra y alguna. */
  const nuevas = (s: KpiSeries) => (s.value !== null && s.newAccounts ? ti.nuevas(s.newAccounts, f.int(s.newAccounts)) : null);
  /** «Calculado sobre 12 videos…»: la base real de una razón. */
  const base = (s: KpiSeries) => (s.value !== null && s.sample !== undefined ? ti.base(s.sample, f.int(s.sample)) : null);

  const seguidores = filtro.platform ? t.followers.labelRed(PLATFORM_LABEL[filtro.platform]) : t.followers.label;
  const vistas = t.views.label(filtro.days);

  return (
    <KpiRow>
      <KpiConInfo
        label={seguidores}
        infoLabel={ti.boton(seguidores)}
        info={info(kpis.hasAccountSeries ? ti.followers : ti.followersSinCuenta, nuevas(kpis.followers))}
        value={valor(kpis.followers, (v) => f.compact(v))}
        sparkline={spark(kpis.followers)}
        {...comparacion(
          kpis.followers,
          t.deltaLabelPunto(filtro.days),
          f,
          kpis.hasAccountSeries ? undefined : t.followers.sinCuenta,
        )}
      />
      <KpiConInfo
        label={vistas}
        infoLabel={ti.boton(vistas)}
        // Esta cifra cuenta otra cosa que las dos de al lado —o la
        // cuenta entera, o solo lo publicado si no hay cuenta— y el (i)
        // dice cuál. Y si la cuenta aún no cerró el último día del
        // reloj, hasta cuándo suma.
        info={info(
          kpis.viewsSource === "content" ? ti.viewsContenido(kpis.posts, f.int(kpis.posts)) : ti.views,
          kpis.viewsWindow && kpis.end && kpis.viewsWindow.end !== kpis.end && ti.hastaCuenta(f.date(kpis.viewsWindow.end)),
          nuevas(kpis.views),
        )}
        value={valor(kpis.views, (v) => f.compact(v))}
        sparkline={spark(kpis.views)}
        {...comparacion(kpis.views, t.deltaLabel(filtro.days), f)}
      />
      <KpiConInfo
        label={t.nonFollowerReach.label}
        infoLabel={ti.boton(t.nonFollowerReach.label)}
        info={info(ti.nonFollowerReach, base(kpis.nonFollowerReach))}
        value={valor(kpis.nonFollowerReach, (v) => f.pct(v))}
        sparkline={spark(kpis.nonFollowerReach)}
        {...comparacion(kpis.nonFollowerReach, t.deltaLabel(filtro.days), f)}
      />
      <KpiConInfo
        label={t.savesPer1k.label}
        infoLabel={ti.boton(t.savesPer1k.label)}
        info={info(ti.savesPer1k, base(kpis.savesPer1k))}
        value={valor(kpis.savesPer1k, (v) => f.compact(v))}
        sparkline={spark(kpis.savesPer1k)}
        {...comparacion(kpis.savesPer1k, t.deltaLabel(filtro.days), f)}
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
