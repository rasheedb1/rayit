import Link from "next/link";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { MESSAGES } from "./messages";

/**
 * El aviso de arriba cuando la cola entera está parada: con el envío del
 * espacio apagado el reclamo no toma nada, y cada fila por salir lo dice
 * también («En espera · envío apagado»). Solo aquí: el widget de uso de
 * /ventas/canales ya lo decía, pero quien reintenta desde la actividad no
 * lo veía.
 */
export function AvisoApagado() {
  const t = MESSAGES.espera;
  return (
    <p role="status" className="rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-sm text-ink">
      {t.aviso}{" "}
      <Link href={OUTREACH_URLS.policySwitch} className="font-medium underline underline-offset-2">{t.avisoEnlace}</Link>
    </p>
  );
}
