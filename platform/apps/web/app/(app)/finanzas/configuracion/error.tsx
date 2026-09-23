"use client";

import { FronteraDeError } from "../../_lib/frontera";
import { MESSAGES } from "../_lib/messages";

/**
 * La frontera de la configuración. Tiene la suya y no hereda la de
 * Finanzas porque el título de esa dice «No pudimos leer tus facturas»,
 * que aquí sería falso y mandaría a buscar el problema al sitio
 * equivocado. Las causas, la pista de despliegue y Reintentar son las
 * mismas de la aplicación ((app)/_lib/frontera.tsx).
 */
export default function ConfiguracionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} titulo={MESSAGES.configuracion.error} origen="finanzas" />;
}
