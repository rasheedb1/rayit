"use client";

import { FronteraDeError } from "../_lib/frontera";
import { MESSAGES } from "./_lib/messages";

/** La frontera de la aplicación con el título de Equipo, como la de Finanzas (_lib/frontera.tsx). */
export default function AccesosError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="accesos" />;
}
