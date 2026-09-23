import { getFollowersByPlatform, getViewsByBucket, type PlatformSeries } from "@mc/db/queries/resumen";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import type { Series } from "@/components/ui/chart-utils";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";
import { hrefDe, MAX_PERIODO, salidaDelVacio, type Filtro } from "./_lib/filtro";

/**
 * Los dos gráficos: seguidores por red en el tiempo y visualizaciones
 * por red y periodo. Los dos vienen del kit (ChartCard + LineChart /
 * BarChart, SVG con los tokens del tema): no entra ninguna librería de
 * gráficos.
 *
 * El nombre de la red viaja como nombre de token de color
 * (`color: "tiktok"`), no como valor: quien pinta es el tema.
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
  const [{ seguidores, views }, ws] = await Promise.all([
    withWorkspace(async (tx) => ({
      seguidores: await getFollowersByPlatform(tx, filtro),
      views: await getViewsByBucket(tx, filtro),
    })),
    getCurrentWorkspace(),
  ]);
  const f: Formatter = formatterFor(ws);
  const t = MESSAGES.graficos;

  const hasta = seguidores.labels.at(-1);
  // Con paso 1 cada barra es un día; con 5 o 10, un bloque de días.
  const porBloques = views.step > 1;
  const porContenido = views.source === "content";

  // Etiquetas del eje en número («16/9»), no «16 sep»: siete barras a
  // 400 px dejan ~37 px por barra y «24 ago» ya no cabe entre dos
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
        // «200 mil». Subir ese margen es cambiar la API de LineChart.
        line={{ fromZero: true }}
        labels={seguidores.labels.map(etiqueta)}
        labelsHeader={t.seguidores.labelsHeader}
        series={aSeries(seguidores.series)}
        format="int"
        axisFormat="compact"
        // La nota explica la escala; sin curva no hay escala que explicar.
        // La de las redes desalineadas, solo cuando se ven varias.
        note={
          seguidores.labels.length === 0
            ? undefined
            : filtro.platform === null
              ? `${t.seguidores.nota} ${t.seguidores.notaRedes}`
              : t.seguidores.nota
        }
        asOf={hasta ? { date: hasta } : undefined}
        emptyState={
          seguidores.labels.length > 0 ? undefined : seguidores.hasAccountSeries ? <SinDatos filtro={filtro} /> : <SinCuenta />
        }
      />
      <ChartCard
        title={t.views.title}
        subtitle={t.views.subtitle(views.step, views.buckets.length)}
        ariaLabel={t.views.aria}
        chart="bar"
        bar={{ mode: "stack" }}
        // Con bloques, la etiqueta ES el rango («7–10/9»): el kit usa la
        // misma para el eje, el tooltip y la tabla, y solo con el primer
        // día nadie podía saber que 317.846 es la suma de cuatro.
        labels={views.buckets.map((b) => (porBloques ? f.dayMonthRange(b.start, b.end) : etiqueta(b.start)))}
        labelsHeader={porBloques ? t.views.labelsHeaderBloque : t.views.labelsHeaderDia}
        series={aSeries(views.series)}
        format="int"
        axisFormat="compact"
        note={views.buckets.length === 0 ? undefined : porContenido ? t.views.notaContenido : t.views.nota(views.step)}
        asOf={views.buckets.length ? { date: views.buckets.at(-1)!.end } : undefined}
        emptyState={views.buckets.length === 0 ? <SinDatos filtro={filtro} /> : undefined}
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
