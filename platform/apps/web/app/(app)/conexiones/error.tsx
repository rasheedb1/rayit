"use client";

import { FronteraDeError } from "../_lib/frontera";
import { MESSAGES } from "./_lib/messages";

/**
 * Lo que ve quien entra a Cuentas cuando la pantalla falla en tiempo de
 * petición (la base caída, un statement_timeout, un workspace que no
 * corresponde a ninguna fila). Hasta CON-4 el módulo no tenía frontera
 * propia y caía en la de (app), que dice «Esta pantalla no se pudo
 * cargar» sin nombrar de qué pantalla se trata.
 *
 * Las causas, la pista de despliegue, «Reintentar» y la salida al plan
 * son las mismas de toda la aplicación ((app)/_lib/frontera.tsx).
 */
export default function ConexionesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="conexiones" />;
}
