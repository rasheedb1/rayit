"use client";

import { MESSAGES } from "@/lib/auth/messages";
import { FronteraDeError } from "../_lib/frontera";

/**
 * Lo que se ve cuando /cuenta no puede leer la sesión o la base: la
 * frontera de la aplicación (_lib/frontera.tsx) con el título de la
 * cuenta. Mismo patrón que Finanzas.
 */
export default function CuentaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.cuentaError} origen="cuenta" />;
}
