import type { ChannelAccountRow } from "@mc/db/queries/canales";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

/**
 * La línea de estado de una cuenta viva: «Comprobada hace 2 horas». El uso
 * de hoy y de la semana ya no va aquí: lo enseña, con sus límites blando y
 * duro, el tope que manda y su semáforo, el widget «Uso de hoy» de esta
 * misma pantalla (VEN-16, UsoPorCanal). La tarjeta dice cómo está la
 * conexión; el widget, cuánto sale. Antes lo decían los dos y la cifra de
 * hoy salía repetida, una debajo de la otra.
 *
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
  if (!live.lastOkAt || live.lastOkAgoS === null) return null;
  return (
    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-fg-2">
      <span className="min-w-0 break-words text-fg-3" title={f.dateTime(live.lastOkAt.toISOString())} data-comprobada="">
        {(live.status === "connected" ? MESSAGES.detail.lastOk : MESSAGES.detail.lastWorked)(f.relative(-live.lastOkAgoS))}
      </span>
    </p>
  );
}
