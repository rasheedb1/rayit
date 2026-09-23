import { BRAND_SNAPSHOT_STATUSES, type CampaignStatus } from "@mc/core";
import type { BrandFollowersResult } from "@mc/db";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import type { ResultadoMarca } from "../_lib/aviso-marca";
import { vistaCuenta } from "../_lib/seguidores";

const t = MESSAGES.seguidores;

/**
 * La sección «Seguidores de la marca» de la ficha (CAM-3): una curva por
 * cuenta de la marca con la línea base y la campaña sombreadas, el ritmo
 * en una pastilla («×12 el ritmo») o la razón de que no haya cifra, y
 * «Actualizar ahora». Todo lo que enseña viene hecho: la serie y el ritmo
 * de @mc/db (core), las frases de _lib/seguidores.ts.
 */
export function SeguidoresMarca({
  data,
  status,
  f,
  actualizar,
  resultado,
  avisos,
}: {
  data: BrandFollowersResult;
  status: CampaignStatus;
  f: Formatter;
  actualizar: () => Promise<void>;
  resultado: ResultadoMarca | null;
  /** Frases ya traducidas desde los códigos de la URL (aviso-marca.ts). */
  avisos: string[];
}) {
  const w = { baselineFrom: data.baselineFrom, startsOn: data.startsOn, endsOn: data.endsOn };
  const midiendo = BRAND_SNAPSHOT_STATUSES.includes(status);

  if (data.accounts.length === 0) {
    return <EmptyState title={t.vacio.title} description={t.vacio.description} />;
  }

  return (
    <div className="space-y-4">
      {(resultado || avisos.length > 0) && (
        <div role="status" className="space-y-1 text-sm">
          {resultado && <p className="text-fg-2">{t.resultado[resultado]}</p>}
          {avisos.map((m) => (
            <p key={m} className="text-warn">
              {m}
            </p>
          ))}
        </div>
      )}
      {data.accounts.map((a) => {
        const v = vistaCuenta(a, w, f);
        const vacia = v.data.length === 0;
        return (
          <div key={v.key} className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Pill kind={v.pill.kind}>{v.pill.text}</Pill>
              {v.resumen && <p className="text-sm text-fg-2">{v.resumen}</p>}
            </div>
            <ChartCard
              title={v.titulo}
              chart="line"
              series={[{ name: t.serie, data: v.data, color: v.color }]}
              labels={v.labels}
              labelsHeader={t.labelsHeader}
              line={{ fromZero: false, shades: v.shades, endLabels: false }}
              ariaLabel={v.ariaLabel}
              format="int"
              axisFormat="compact"
              legend={false}
              asOf={v.asOf ?? undefined}
              // Sin curva, las frases van en el sitio del gráfico; con curva, debajo.
              note={!vacia && v.notas.length > 0 ? v.notas.join(" ") : undefined}
              emptyState={vacia ? <p className="py-6 text-sm leading-6 text-fg-2">{v.notas.join(" ") || t.pillSinLecturas}</p> : undefined}
            />
          </div>
        );
      })}
      {midiendo ? (
        <form action={actualizar}>
          <Button type="submit" variant="secondary" size="sm">
            {t.actualizar}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-fg-3">{t.medicionTerminada}</p>
      )}
    </div>
  );
}
