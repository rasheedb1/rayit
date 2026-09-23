"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "../_lib/messages";

/**
 * La frontera de la lista de empresas. Hasta la ronda 5 caía en la de
 * Ventas, que dice «No pudimos leer tu pipeline»: con la base caída o
 * con un workspace que no existe, lo que no se leyó aquí son las
 * empresas. Lo demás —las causas, la pista, Reintentar y la salida al
 * plan— es la frontera de la aplicación.
 */
export default function EmpresasError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.errorEmpresas} origen="ventas/empresas" />;
}
