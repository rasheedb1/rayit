import { listAccountAudience, listAccounts, type AccountAudience } from "@mc/db";
import { Audiencia } from "@/app/(app)/conexiones/[id]/audiencia";
import { SectionTitle } from "@/components/page-header";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformPill } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";
import type { Filtro } from "./_lib/filtro";

const t = MESSAGES.audiencia;

/**
 * «Quién te ve» (RES-4): la demografía que CON-7 recolecta de cada
 * cuenta autorizada, en el Resumen y con el filtro de red del panel. Las
 * barras y las etiquetas son las mismas que la ficha de la cuenta en
 * Conexiones (conexiones/[id]/audiencia.tsx): un solo sitio decide cómo
 * se lee un tramo, y lo que falta lo dice con la frase de la migración
 * (metric_gap), no con un cero.
 *
 * «Cuándo publicar» (la hora a la que están conectados los seguidores)
 * no se pinta porque CON-7 todavía no lo recolecta: ninguna tabla lo
 * guarda. Se dice en una frase, en vez de un gráfico vacío.
 */
export async function QuienTeVe({ filtro }: { filtro: Filtro }) {
  const [{ audiencias, cuentas }, ws] = await Promise.all([
    withWorkspace(async (tx) => ({ audiencias: await listAccountAudience(tx), cuentas: await listAccounts(tx) })),
    getCurrentWorkspace(),
  ]);
  const f = formatterFor(ws);
  const delFiltro = audiencias.filter((a) => !filtro.platform || a.platformId === filtro.platform);
  const autorizada = (a: AccountAudience) => cuentas.find((c) => c.id === a.connectionId)?.accessMode === "direct_oauth";
  const conDatos = delFiltro.filter((a) => a.dimensions.length > 0);

  return (
    <section aria-label={t.title} className="mt-8">
      <SectionTitle meta={t.description}>{t.title}</SectionTitle>
      {conDatos.length === 0 ? (
        <EmptyState
          title={delFiltro.length === 0 ? t.vacio.sinCuentas : t.vacio.sinDemografia}
          description={delFiltro.some(autorizada) ? t.vacio.autorizada : t.vacio.porArroba}
          action={{ label: t.vacio.accion, href: "/conexiones" }}
        />
      ) : (
        <div className="space-y-8">
          {conDatos.map((a) => (
            <div key={a.connectionId}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <PlatformPill platformId={a.platformId} />
                <span>{a.handle ? `@${a.handle}` : t.sinArroba}</span>
              </div>
              <Audiencia audiencia={a} autorizada={autorizada(a)} f={f} />
            </div>
          ))}
        </div>
      )}
      {/* Lo que no se mide todavía se dice; un gráfico por hora vacío mentiría. */}
      <p className="mt-4 text-xs leading-5 text-muted">{t.cuandoPublicar}</p>
    </section>
  );
}

export function QuienTeVeEsqueleto() {
  return (
    <section className="mt-8" aria-busy="true">
      <SectionTitle meta={t.description}>{t.title}</SectionTitle>
      <ChartCard title={MESSAGES.loading.audiencia} ariaLabel={MESSAGES.loading.audiencia} chart="bar" labels={[]} series={[]} loading />
    </section>
  );
}
