"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "./messages";

/** La frontera de /ventas/cadencias: la de la aplicación con el nombre y el título de la pantalla. */
export default function CadenciasError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.error} origen="ventas/cadencias" />;
}
