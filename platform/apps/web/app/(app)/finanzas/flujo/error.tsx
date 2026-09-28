"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "../_lib/messages";

/**
 * La frontera del flujo de caja. Tiene la suya y no hereda la de
 * Finanzas porque aquella dice «No pudimos leer tus facturas», que aquí
 * sería falso: esta pantalla también lee negocios y gastos.
 */
export default function FlujoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.flujo.error} origen="finanzas" />;
}
