import { getSeguidoresPorRed, getViewsPorBloque, type SeriePorRed } from "@mc/db/queries/resumen";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import type { Series } from "@/components/ui/chart-utils";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";
import { hrefDe, type Filtro } from "./_lib/filtro";

/**
 * Los dos gráficos: seguidores por red en el tiempo y visualizaciones
 * por red y periodo. Los dos vienen del kit (ChartCard + LineChart /
 * BarChart, SVG con los tokens del tema): no entra ninguna librería de
 * gráficos.
 *
 * El nombre de la red viaja como nombre de token de color
 * (`color: "tiktok"`), no como valor: quien pinta es el tema.
 */
function aSeries(series: SeriePorRed[]): Series[] {
  return series.map((s) => ({ name: PLATFORM_LABEL[s.platformId], data: s.data, color: s.platformId }));
}

function SinDatos({ filtro }: { filtro: Filtro }) {
  const t = MESSAGES.vacio.periodoSinDatos;
  return (
    <EmptyState
      title={t.title}
      description={t.description}
      action={{ label: t.accion, href: hrefDe({ ...filtro, dias: 90 }) }}
      className="min-h-[260px]"
    />
  );
}

export async function Graficos({ filtro }: { filtro: Filtro }) {
  const [{ seguidores, views }, ws] = await Promise.all([
    withWorkspace(async (tx) => ({
      seguidores: await getSeguidoresPorRed(tx, filtro),
      views: await getViewsPorBloque(tx, filtro),
    })),
    getCurrentWorkspace(),
  ]);
  const f: Formatter = formatterFor(ws);
  const t = MESSAGES.graficos;

  const hasta = seguidores.labels.at(-1);
  // Con paso 1 cada barra es un día; con 2 o 7, un bloque de días.
  const porBloques = views.paso > 1;
  const vacio = seguidores.labels.length === 0;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title={t.seguidores.title}
        subtitle={t.seguidores.subtitle(seguidores.labels.length)}
        ariaLabel={t.seguidores.aria}
        chart="line"
        // Con varias redes el eje arranca en cero: si arranca en el
        // mínimo, las marcas salen desplazadas por el valor de Facebook
        // («220,1 mil») y no caben en el margen del eje. Con una sola
        // red no hay ese desfase y arrancar en el mínimo enseña la curva.
        line={{ fromZero: filtro.red === null }}
        labels={seguidores.labels.map((d) => f.date(d))}
        labelsHeader={t.seguidores.labelsHeader}
        series={aSeries(seguidores.series)}
        format="int"
        axisFormat="compact"
        note={t.seguidores.nota}
        asOf={hasta ? { date: hasta } : undefined}
        emptyState={vacio ? <SinDatos filtro={filtro} /> : undefined}
      />
      <ChartCard
        title={t.views.title}
        subtitle={t.views.subtitle(views.paso, views.bloques.length)}
        ariaLabel={t.views.aria}
        chart="bar"
        bar={{ mode: "stack" }}
        labels={views.bloques.map((b) => f.date(b.inicio))}
        labelsHeader={porBloques ? t.views.labelsHeaderBloque : t.views.labelsHeaderDia}
        series={aSeries(views.series)}
        format="int"
        axisFormat="compact"
        note={t.views.nota(views.paso)}
        asOf={views.bloques.length ? { date: views.bloques.at(-1)!.fin } : undefined}
        emptyState={views.bloques.length === 0 ? <SinDatos filtro={filtro} /> : undefined}
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
