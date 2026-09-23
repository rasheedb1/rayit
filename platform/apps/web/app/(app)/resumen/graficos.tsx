import { getFollowersByPlatform, getViewsByWeek, type PlatformSeries } from "@mc/db/queries/resumen";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import type { Series } from "@/components/ui/chart-utils";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";
import { etiquetasDelEje } from "./_lib/eje";
import { hrefDe, MAX_PERIODO, salidaDelVacio, type Filtro } from "./_lib/filtro";

/**
 * Los dos gráficos: seguidores por red en el tiempo y visualizaciones
 * por red y semana. Los dos vienen del kit (ChartCard + LineChart /
 * BarChart, SVG con los tokens del tema): no entra ninguna librería de
 * gráficos.
 *
 * El nombre de la red viaja como nombre de token de color
 * (`color: "tiktok"`), no como valor: quien pinta es el tema.
 *
 * Cada tarjeta lleva como mucho UNA línea de nota, y solo si cambia
 * cómo se lee el gráfico. Que las fechas son días cerrados se dice una
 * sola vez, en el aviso de frescura.
 */
function aSeries(series: PlatformSeries[]): Series[] {
  return series.map((s) => ({ name: PLATFORM_LABEL[s.platformId], data: s.data, color: s.platformId }));
}

/**
 * El estado vacío de una tarjeta ofrece la salida que de verdad existe.
 * Ofrecer «Ver 90 días» a quien YA está en 90 días es un enlace a la
 * página en la que está, y decirle «prueba con un periodo más largo» es
 * aconsejarle algo imposible: cuando no queda salida, se explica por
 * qué no hay datos y no se pinta ningún botón.
 */
function SinDatos({ filtro }: { filtro: Filtro }) {
  const t = MESSAGES.vacio.periodoSinDatos;
  const cual = salidaDelVacio(filtro);
  const salida =
    cual === "masLargo"
      ? { ...t.masLargo, href: hrefDe({ ...filtro, days: MAX_PERIODO }) }
      : cual === "quitarRed"
        ? { ...t.quitarRed, href: hrefDe({ ...filtro, platform: null }) }
        : null;

  return (
    <EmptyState
      title={t.title}
      description={salida?.description ?? t.sinSalida.description}
      action={salida ? { label: salida.accion, href: salida.href } : undefined}
      className="min-h-[260px]"
    />
  );
}

/**
 * El vacío del gráfico semanal. Sus semanas no dependen del periodo, así
 * que «Ver 90 días» no le cambiaría nada: la única salida posible es
 * quitar el filtro de red.
 */
function SinSemanas({ filtro }: { filtro: Filtro }) {
  const t = MESSAGES.vacio.semanasSinDatos;
  return (
    <EmptyState
      title={t.title}
      description={filtro.platform ? t.quitarRed.description : t.sinSalida.description}
      action={filtro.platform ? { label: t.quitarRed.accion, href: hrefDe({ ...filtro, platform: null }) } : undefined}
      className="min-h-[260px]"
    />
  );
}

/**
 * Sin serie de cuenta —un workspace que solo importó CSV— no hay
 * seguidores que dibujar en NINGÚN periodo. Decirle «prueba con 90
 * días» sería mandarlo a otra pantalla vacía: lo que falta es la
 * cuenta, y la salida es conectarla.
 */
function SinCuenta() {
  const t = MESSAGES.graficos.seguidores.sinCuenta;
  return (
    <EmptyState
      title={t.title}
      description={t.description}
      action={{ label: t.accion, href: "/conexiones" }}
      className="min-h-[260px]"
    />
  );
}

export async function Graficos({ filtro }: { filtro: Filtro }) {
  const [{ seguidores, semanas }, ws] = await Promise.all([
    withWorkspace(async (tx) => ({
      seguidores: await getFollowersByPlatform(tx, filtro),
      semanas: await getViewsByWeek(tx, { platform: filtro.platform }),
    })),
    getCurrentWorkspace(),
  ]);
  const f: Formatter = formatterFor(ws);
  const t = MESSAGES.graficos;

  const hasta = seguidores.labels.at(-1);
  const porContenido = semanas.source === "content";

  // Etiquetas del eje en número («16/9»), no «16 sep»: doce barras a
  // 400 px dejan ~28 px por barra y «24 ago» ya no cabe entre dos
  // marcas; seis fechas en el eje de la línea, tampoco. El orden
  // día/mes lo pone el locale del workspace, no este archivo.
  const etiqueta = (dia: string) => f.dayMonth(dia);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title={t.seguidores.title}
        subtitle={t.seguidores.subtitle(seguidores.labels.length)}
        ariaLabel={t.seguidores.aria}
        chart="line"
        // El eje arranca SIEMPRE en cero, también con una sola red.
        // Arrancando en el mínimo, las marcas dejan de ser redondas
        // —«216,1 mil»— y no caben en los 48 px de margen del eje del
        // kit: se cortaban por la izquierda. En cero salen «100 mil»,
        // «200 mil», y la curva enseña el tamaño y no solo el movimiento.
        line={{ fromZero: true }}
        labels={seguidores.labels.map(etiqueta)}
        labelsHeader={t.seguidores.labelsHeader}
        series={aSeries(seguidores.series)}
        format="int"
        axisFormat="compact"
        // Solo si se ven varias redes a la vez: una que empezó a medirse
        // dentro del periodo aparece en cero hasta su primera lectura.
        note={filtro.platform === null && seguidores.series.length > 1 ? t.seguidores.notaRedes : undefined}
        asOf={hasta ? { date: hasta } : undefined}
        emptyState={
          seguidores.labels.length > 0 ? undefined : seguidores.hasAccountSeries ? <SinDatos filtro={filtro} /> : <SinCuenta />
        }
      />
      <ChartCard
        title={t.views.title}
        subtitle={t.views.subtitle(semanas.weeks.length)}
        ariaLabel={t.views.aria}
        chart="bar"
        // La categoría ES la semana («15–21/9») en el tooltip y en la
        // tabla. Bajo la barra, en cambio, va solo el último día («21/9»):
        // a 400 px dos rangos seguidos se pisaban. Y la etiqueta que el
        // kit pintaría pegada a la última se deja vacía (etiquetasDelEje).
        bar={{ mode: "stack", axisLabels: etiquetasDelEje(semanas.weeks.map((s) => etiqueta(s.end))) }}
        labels={semanas.weeks.map((s) => f.dayMonthRange(s.start, s.end))}
        labelsHeader={t.views.labelsHeader}
        series={aSeries(semanas.series)}
        format="int"
        axisFormat="compact"
        note={semanas.weeks.length === 0 ? undefined : porContenido ? t.views.notaContenido : t.views.nota}
        asOf={semanas.weeks.length ? { date: semanas.weeks.at(-1)!.end } : undefined}
        emptyState={semanas.weeks.length === 0 ? <SinSemanas filtro={filtro} /> : undefined}
      />
    </div>
  );
}

/** Dos tarjetas del mismo tamaño mientras la base responde. */
export function GraficosEsqueleto() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {MESSAGES.loading.graficos.map((title) => (
        <ChartCard key={title} title={title} ariaLabel={title} chart="line" labels={[]} series={[]} loading />
      ))}
    </div>
  );
}
