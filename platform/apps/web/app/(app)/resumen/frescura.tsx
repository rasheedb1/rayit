import { getFrescuraPorConexion } from "@mc/db/queries/resumen";
import { DataAsOf } from "@/components/ui/data-as-of";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { MESSAGES } from "./messages";

/**
 * «Datos hasta el {fecha}», una línea por conexión.
 *
 * Va debajo de las cifras y no encima porque no es una alarma: es el
 * pie de página que evita la pregunta «¿esto está actualizado?». Cuando
 * una conexión sí tiene un problema —un permiso por vencer— sube una
 * pastilla, que es lo que se mira.
 */
export async function Frescura() {
  const filas = await withWorkspace((tx) => getFrescuraPorConexion(tx));
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
        {filas.map((c) => (
          <li key={c.connectionId} className="flex min-w-0 flex-col gap-1.5 bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <PlatformPill platformId={c.platformId} />
              {c.handle && <span className="truncate text-xs text-muted">@{c.handle}</span>}
            </div>
            {c.ultimoDiaCuenta ? (
              <DataAsOf
                date={c.ultimoDiaCuenta}
                source={c.ultimaFuente ? (t.fuente[c.ultimaFuente] ?? c.ultimaFuente) : undefined}
              />
            ) : (
              <p className="text-xs text-muted">{t.sinLecturas}</p>
            )}
            {c.tokenExpiringSoon && <Pill kind="warn">{t.tokenPorVencer}</Pill>}
          </li>
        ))}
      </ul>
    </section>
  );
}
