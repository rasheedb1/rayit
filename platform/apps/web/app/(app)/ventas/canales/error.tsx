"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "./messages";

/**
 * La frontera de Canales: con la base caída o un espacio que no existe,
 * lo que no se leyó aquí son las cuentas de canal. Las causas, la pista,
 * Reintentar y la salida al plan son las de la aplicación.
 */
export default function CanalesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="ventas/canales" />;
}
