"use client";

import { FronteraDeError } from "../_lib/frontera";
import { MESSAGES } from "./messages";

/**
 * Lo que ve quien entra a Resumen cuando la pantalla falla en tiempo de
 * petición (DATABASE_URL inválida, statement_timeout, un
 * DEMO_WORKSPACE_ID que no corresponde a ninguna fila…): la frontera de
 * la aplicación (_lib/frontera.tsx) con el nombre y el título del
 * módulo. El asistente de importación tiene la suya, porque allí lo que
 * hay que decir es que no se escribió nada.
 */
export default function ResumenError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="resumen" />;
}
