"use client";

import { FronteraDeError } from "./_lib/frontera";

/**
 * La frontera de error del segmento (app): la red de abajo.
 *
 * Sin ella, cualquier pantalla sin frontera propia que fallara en tiempo
 * de petición respondía 500 con el documento genérico de Next, en
 * inglés y fuera del marco de la aplicación. Con este archivo, el error
 * se ve DENTRO del Shell (la barra lateral sigue ahí, se puede navegar a
 * otro módulo) y en español. Lo que pinta vive en _lib/frontera.tsx,
 * que comparten las fronteras de módulo.
 *
 * Next exige que sea un componente cliente.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <FronteraDeError error={error} reset={reset} origen="app" />;
}
