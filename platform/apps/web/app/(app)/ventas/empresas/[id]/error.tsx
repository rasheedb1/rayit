"use client";

import { FronteraDeError } from "../../../_lib/frontera";
import { MESSAGES } from "../../_lib/messages";

/**
 * La frontera de la ficha de una empresa: lo que no se pudo leer es ESTA
 * empresa, no la lista ni el pipeline. Una empresa que no existe (o que
 * es de otro workspace) no pasa por aquí: la ficha pinta su propio «no
 * encontrada».
 */
export default function FichaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.errorFicha} origen="ventas/empresas/ficha" />;
}
