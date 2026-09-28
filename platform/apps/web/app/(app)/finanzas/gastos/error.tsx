"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "../_lib/messages";

/**
 * Gastos tiene su propia frontera porque la de Finanzas dice «no pudimos
 * leer tus facturas», y aquí eso sería falso. Las causas, la pista de
 * despliegue y «Reintentar» son las mismas de la aplicación.
 */
export default function GastosError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.gastos.error} origen="finanzas" />;
}
