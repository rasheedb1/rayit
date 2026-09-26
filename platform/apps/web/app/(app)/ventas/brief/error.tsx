"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "../_lib/messages";

/**
 * La frontera del brief. Tiene la suya y no hereda la de Ventas: aquella
 * habla del radar y del pipeline, y quien llega aquí estaba editando su
 * brief. Las causas, la pista de despliegue y Reintentar son las de la
 * aplicación ((app)/_lib/frontera.tsx).
 */
export default function BriefError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.brief.errorTitle} origen="ventas" />;
}
