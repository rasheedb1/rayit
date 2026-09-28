"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "./_lib/messages";

/**
 * Lo que ve quien entra a «Ingresos de plataformas» cuando la pantalla
 * falla en tiempo de petición. La frontera del segmento (app) pone las
 * causas, la pista de despliegue y la salida; aquí solo el nombre y el
 * título, como en el resto de los módulos.
 */
export default function IngresosError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="finanzas" />;
}
