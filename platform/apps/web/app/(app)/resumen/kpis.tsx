import { getResumenKpis, type KpiSerie } from "@mc/db/queries/resumen";
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
 * anterior, la variación y la serie, todo resuelto en SQL. Este archivo
 * solo elige qué formato le toca a cada número.
 */

/** Una sparkline de un punto no dice nada; el kit la dibujaría plana. */
function spark(serie: KpiSerie): number[] | undefined {
  return serie.spark.length > 1 ? serie.spark : undefined;
}

/** El delta solo se muestra si existe; si no, se dice por qué. */
function comparacion(serie: KpiSerie, label: string) {
  return serie.delta === null
    ? { note: MESSAGES.kpis.sinComparacion }
    : { delta: serie.delta, deltaLabel: label };
}

function valor(serie: KpiSerie, formatear: (v: number) => string): string {
  return serie.value === null ? MESSAGES.kpis.sinDato : formatear(serie.value);
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
        label={filtro.red ? t.followers.labelRed(PLATFORM_LABEL[filtro.red]) : t.followers.label}
        value={valor(kpis.followers, (v) => f.compact(v))}
        sparkline={spark(kpis.followers)}
        {...comparacion(kpis.followers, t.deltaLabelPunto(filtro.dias))}
      />
      <Kpi
        label={t.views.label(filtro.dias)}
        value={valor(kpis.views, (v) => f.compact(v))}
        sparkline={spark(kpis.views)}
        {...comparacion(kpis.views, t.deltaLabel(filtro.dias))}
      />
      <Kpi
        label={t.nonFollowerReach.label}
        value={valor(kpis.nonFollowerReach, (v) => f.pct(v))}
        note={kpis.nonFollowerReach.value === null ? undefined : t.nonFollowerReach.note(kpis.posts)}
        sparkline={spark(kpis.nonFollowerReach)}
        {...(kpis.nonFollowerReach.delta === null ? {} : { delta: kpis.nonFollowerReach.delta, deltaLabel: t.deltaLabel(filtro.dias) })}
      />
      <Kpi
        label={t.savesPer1k.label}
        value={valor(kpis.savesPer1k, (v) => f.compact(v))}
        note={kpis.savesPer1k.value === null ? undefined : t.savesPer1k.note}
        sparkline={spark(kpis.savesPer1k)}
        {...(kpis.savesPer1k.delta === null ? {} : { delta: kpis.savesPer1k.delta, deltaLabel: t.deltaLabel(filtro.dias) })}
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
