"use client";

import { FronteraDeError } from "../../../../../_lib/frontera";
import { PITCH } from "./messages";

/** La frontera del pitch: lo que no se pudo abrir es el editor de ESTA empresa, no su ficha. */
export default function PitchError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={PITCH.errorFrontera} origen="ventas/empresas/pitch" />;
}
