"use client";

import { FronteraDeError } from "../_lib/frontera";
import { MESSAGES } from "./messages";

/**
 * Lo que ve el creador cuando /cotizar falla en tiempo de petición: la
 * frontera de la aplicación (_lib/frontera.tsx) con el nombre y el
 * título del módulo. Las causas, la pista de despliegue, «Reintentar»
 * que vuelve a pedir al servidor y la salida al plan son las mismas en
 * todos los módulos.
 */
export default function CotizarError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="cotizar" />;
}
