import { getFreshnessByConnection, type ConnectionFreshness } from "@mc/db/queries/resumen";
import { DataAsOf } from "@/components/ui/data-as-of";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
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
  const [filas, ws] = await Promise.all([
    withWorkspace((tx) => getFreshnessByConnection(tx, { platform: filtro.platform })),
    getCurrentWorkspace(),
  ]);
  return <FrescuraLista filas={filas} f={formatterFor(ws)} />;
}

/** Más de esto por detrás del reloj del módulo, y la conexión se señala. */
const DIAS_TOLERADOS = 2;

/**
 * Las dos fuentes van en líneas separadas, cada una con su fecha:
 *
 *   - lo que trae la conexión (la serie de cuenta del recolector o, si
 *     no la hay, su última lectura de contenido por API);
 *   - lo último que llegó por CSV, con la FECHA DE EXPORTACIÓN tal cual
 *     («CSV exportado el 12 sep»), que es la que el creador escribió en
 *     el paso 2 y la que le confirmó el paso 4. Con la regla del reloj
 *     salía «datos hasta el 11», un día menos sin explicación.
 *
 * Mezclarlas en una sola fecha tenía dos fallos: una cuenta alimentada
 * solo por CSV salía como «Sin lecturas todavía» justo después de
 * anunciar «N videos, M lecturas», y un CSV subido a una cuenta OAuth
 * tapaba que su recolector llevaba días sin sincronizar.
 *
 * La de la conexión llega como DÍA CERRADO ('YYYY-MM-DD') y con la regla
 * del reloj del módulo: el aviso y el resto de la página dicen el mismo
 * día. La del CSV llega como instante y se formatea en la zona del
 * workspace, así que dice el mismo día que escribió el creador.
 *
 * Y dos pastillas destapan lo que una fecha vieja sola no dice: la
 * conexión que no está sana (vencida, revocada, con error, pausada) y la
 * que se quedó más de dos días por detrás del resto.
 *
 * Cada tarjeta lleva su propio borde: el truco del hueco de 1 px sobre
 * un fondo de borde pintaba de gris las celdas vacías de la rejilla, y
 * con una sola conexión tres cuartos de la fila eran un bloque gris.
 */
export function FrescuraLista({ filas, f }: { filas: readonly ConnectionFreshness[]; f: Formatter }) {
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
      {/* Una vez para toda la página, con palabras de creador: cada «datos hasta el…» es un día ya cerrado. */}
      <p className="-mt-1 mb-3 text-xs text-muted">{t.diaCerrado}</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {filas.map((c) => {
          const sincronizado = c.lastAccountDay ?? c.lastSyncedReadingDay;
          const atrasada = c.daysBehind !== null && c.daysBehind > DIAS_TOLERADOS;
          return (
            <li key={c.connectionId} className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <PlatformPill platformId={c.platformId} />
                {c.handle && <span className="truncate text-xs text-muted">@{c.handle}</span>}
              </div>
              {sincronizado && <DataAsOf date={sincronizado} source={t.fuente.api} />}
              {c.lastCsvExportAt && (
                <p className="text-xs text-muted">
                  <time dateTime={c.lastCsvExportAt}>{t.csvExportado(f.date(c.lastCsvExportAt))}</time>
                </p>
              )}
              {!sincronizado && !c.lastCsvExportAt && <p className="text-xs text-muted">{t.sinLecturas}</p>}
              {(c.status !== "active" || atrasada || c.tokenExpiringSoon) && (
                <div className="flex flex-wrap gap-1.5">
                  {c.status !== "active" && <Pill kind="bad">{t.estado[c.status] ?? t.estadoDesconocido}</Pill>}
                  {atrasada && <Pill kind="warn">{t.atrasada(c.daysBehind!, f.int(c.daysBehind!))}</Pill>}
                  {c.tokenExpiringSoon && <Pill kind="warn">{t.tokenPorVencer}</Pill>}
                </div>
              )}
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
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-4 py-3">
            <span className="h-5 w-24 animate-pulse rounded-sm bg-hover" />
            <span className="h-3 w-32 animate-pulse rounded-sm bg-hover" />
          </li>
        ))}
      </ul>
    </section>
  );
}
