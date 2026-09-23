import { getFreshnessByConnection, type ConnectionFreshness } from "@mc/db/queries/resumen";
import { DataAsOf } from "@/components/ui/data-as-of";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { MESSAGES } from "./messages";
import type { Filtro } from "./_lib/filtro";

/**
 * «Datos hasta el {fecha}», una línea por conexión del filtro.
 *
 * Va debajo de las cifras y no encima porque no es una alarma: es el
 * pie de página que evita la pregunta «¿esto está actualizado?». Cuando
 * una conexión sí tiene un problema —un permiso por vencer— sube una
 * pastilla, que es lo que se mira.
 *
 * Respeta el filtro por red: con `?red=tiktok` la página entera es de
 * TikTok, y listar aquí las cuatro conexiones rompía esa lectura única.
 */
export async function Frescura({ filtro }: { filtro: Filtro }) {
  const filas = await withWorkspace((tx) => getFreshnessByConnection(tx, { platform: filtro.platform }));
  return <FrescuraLista filas={filas} />;
}

/**
 * Las dos fuentes van en líneas separadas, cada una con su fecha:
 *
 *   - lo que trae la conexión (la serie de cuenta del recolector o, si
 *     no la hay, su última lectura de contenido por API);
 *   - lo último que llegó por CSV.
 *
 * Mezclarlas en una sola fecha tenía dos fallos: una cuenta alimentada
 * solo por CSV salía como «Sin lecturas todavía» justo después de
 * anunciar «N videos, M lecturas», y un CSV subido a una cuenta OAuth
 * tapaba que su recolector llevaba días sin sincronizar.
 */
export function FrescuraLista({ filas }: { filas: readonly ConnectionFreshness[] }) {
  if (filas.length === 0) return null;
  const t = MESSAGES.frescura;

  return (
    <section className="mt-10" aria-labelledby="frescura">
      <SectionTitle
        meta={
          <Button size="sm" variant="ghost" href="/conexiones">
            {t.revisar}
          </Button>
        }
      >
        <span id="frescura">{t.title}</span>
      </SectionTitle>
      <ul className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {filas.map((c) => {
          const sincronizado = c.lastAccountDay ?? c.lastSyncedReadingAt;
          return (
            <li key={c.connectionId} className="flex min-w-0 flex-col gap-1.5 bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <PlatformPill platformId={c.platformId} />
                {c.handle && <span className="truncate text-xs text-muted">@{c.handle}</span>}
              </div>
              {sincronizado && <DataAsOf date={sincronizado} source={t.fuente.api} />}
              {c.lastCsvReadingAt && <DataAsOf date={c.lastCsvReadingAt} source={t.fuente.csv} />}
              {!sincronizado && !c.lastCsvReadingAt && <p className="text-xs text-muted">{t.sinLecturas}</p>}
              {c.tokenExpiringSoon && <Pill kind="warn">{t.tokenPorVencer}</Pill>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Cuatro tarjetas del mismo alto mientras la base responde. */
export function FrescuraEsqueleto() {
  return (
    <section className="mt-10" aria-busy="true" aria-label={MESSAGES.loading.frescura}>
      <SectionTitle>{MESSAGES.frescura.title}</SectionTitle>
      <ul className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex min-w-0 flex-col gap-1.5 bg-surface px-4 py-3">
            <span className="h-5 w-24 animate-pulse rounded-sm bg-hover" />
            <span className="h-3 w-32 animate-pulse rounded-sm bg-hover" />
          </li>
        ))}
      </ul>
    </section>
  );
}
