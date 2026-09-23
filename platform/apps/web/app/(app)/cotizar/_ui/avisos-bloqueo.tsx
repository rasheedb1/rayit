import type { MediaKitLockNotice } from "@mc/db/queries/cotizar";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { Formatter } from "@/lib/format";
import { desbloquearMediaKit, marcarAvisoBloqueoVisto, type VueltaAvisoBloqueo } from "../actions";
import { MESSAGES } from "../messages";

/**
 * «Tu media kit quedó bloqueado» (notification 'media_kit_locked'): el
 * techo POR ENLACE de contraseñas fallidas (0030) dejó fuera a todos,
 * marca incluida. Sale en la lista de media kits y en la de cotizaciones,
 * que es donde el creador ya mira sus avisos, con «Desbloquear» (si el
 * bloqueo sigue) y «Entendido».
 *
 * El texto se compone aquí con el kit y su bloqueo de HOY, con la zona
 * del workspace; lo guardado en la notificación es solo el respaldo.
 */
export function AvisosBloqueo({
  avisos,
  f,
  vuelta,
}: {
  avisos: MediaKitLockNotice[];
  f: Pick<Formatter, "date" | "time" | "int">;
  /** La lista en la que se pinta: «Entendido» vuelve a ella. */
  vuelta: VueltaAvisoBloqueo;
}) {
  if (avisos.length === 0) return null;
  const t = MESSAGES.mediaKit.avisosBloqueo;
  return (
    <section aria-labelledby="avisos-bloqueo" className="mb-8">
      <SectionTitle meta={f.int(avisos.length)}>
        <span id="avisos-bloqueo">{t.title}</span>
      </SectionTitle>
      <ul className="divide-y divide-border rounded-md border border-warn/30 bg-warn-wash">
        {avisos.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-aviso-bloqueo={a.mediaKitId}>
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">{t.titulo(f.date(a.mediaKitCreatedAt))}</p>
              <p className="mt-0.5 text-xs leading-4 text-ink-2">
                {a.lockedUntil ? t.hasta(f.time(a.lockedUntil)) : t.yaAbierto} {t.consejo}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {a.lockedUntil && (
                <form action={desbloquearMediaKit.bind(null, a.mediaKitId)}>
                  <Button size="sm" type="submit" aria-label={MESSAGES.mediaKit.desbloquearAria}>
                    {MESSAGES.mediaKit.desbloquear}
                  </Button>
                </form>
              )}
              <form action={marcarAvisoBloqueoVisto.bind(null, a.id, vuelta)}>
                <Button size="sm" variant="ghost" type="submit">
                  {t.entendido}
                </Button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
