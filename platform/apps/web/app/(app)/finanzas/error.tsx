"use client";

import { FronteraDeError } from "../_lib/frontera";
import { MESSAGES } from "./_lib/messages";

/**
 * Lo que ve quien entra a Finanzas cuando la pantalla falla en tiempo de
 * petición (la base caída, un statement_timeout, un DEMO_WORKSPACE_ID
 * que no corresponde a ninguna fila…): la frontera de la aplicación con
 * el nombre y el título del módulo.
 *
 * Hasta la ronda 3 tenía su propio texto —«la base de datos no respondió
 * a tiempo o rechazó la conexión»—, que era falso con un workspace que
 * no existe (la base sí contestó) y mandaba a quien desplegaba a buscar
 * un problema de red. Las dos causas, la pista de despliegue y la salida
 * al plan son ahora las mismas en todas las fronteras (_lib/frontera.tsx).
 */
export default function FinanzasError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="finanzas" />;
}
