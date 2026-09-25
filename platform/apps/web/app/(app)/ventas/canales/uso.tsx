import type { ChannelAccountRow } from "@mc/db/queries/canales";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

/**
 * La línea de uso de una cuenta viva: «Hoy 3 de 20 · Semana 12 de 100 ·
 * Comprobada hace 2 horas». Los números vienen sumados de la base y los
 * formatea el formateador del espacio; aquí no se calcula nada.
 *
 * Los dos contadores no se parten a medias (whitespace-nowrap: son cortos).
 * «Comprobada …» va en relativo, como en las integraciones de Vercel y de
 * Linear, con la fecha completa en el title, y SÍ puede partirse: la fecha
 * completa con nowrap se salía de la fila a 400 px y daba scroll
 * horizontal a 360 px.
 *
 * En una cuenta caída, last_ok_at es la última vez que FUNCIONÓ, no la
 * última vez que se miró (la caída se detectó después): ahí la línea dice
 * «Funcionó por última vez …», y «Comprobada» queda para las conectadas.
 */
export function UsoCuenta({ live, f }: { live: ChannelAccountRow; f: Formatter }) {
  return (
    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-fg-2">
      <span className="whitespace-nowrap">{MESSAGES.detail.usageToday(f.int(live.usedToday), f.int(live.limits.effectiveDaily))}</span>
      <span className="whitespace-nowrap">{MESSAGES.detail.usageWeek(f.int(live.usedThisWeek), f.int(live.limits.effectiveWeekly))}</span>
      {live.lastOkAt && live.lastOkAgoS !== null && (
        <span className="min-w-0 break-words text-fg-3" title={f.dateTime(live.lastOkAt.toISOString())} data-comprobada="">
          {(live.status === "connected" ? MESSAGES.detail.lastOk : MESSAGES.detail.lastWorked)(f.relative(-live.lastOkAgoS))}
        </span>
      )}
    </p>
  );
}
