"use client";

import { FronteraDeError } from "../_lib/frontera";
import { MESSAGES } from "./_lib/messages";

/**
 * Lo que ve quien entra a Ventas cuando la pantalla falla en tiempo de
 * petición: la frontera de la aplicación con el nombre y el título del
 * módulo. Mismo arreglo que Finanzas: antes tenía su propia copia, con
 * un `reset()` que no volvía a pedir nada al servidor y un texto que
 * culpaba a la base también cuando lo que falla es la configuración.
 */
export default function VentasError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="ventas" />;
}
