"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "../messages";

/**
 * La frontera de error del asistente de importación.
 *
 * Va aquí y no un nivel arriba porque el error de /resumen habla de
 * métricas que no se pudieron leer, y en esta pantalla eso sería
 * mentira: aquí no hay ninguna consulta de métricas, y lo que hay que
 * decir es que NO se escribió nada.
 *
 * Next exige que sea un componente cliente. `reset()` vuelve a
 * renderizar el segmento, que arranca otra vez en el paso 1; el error
 * queda en la consola del servidor.
 */
export default function ImportarError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.importar.errorPagina;

  useEffect(() => {
    console.error("[resumen/importar] el asistente falló", error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-xs text-muted">{t.eyebrow}</p>
      <h1 className="mt-2 text-xl font-semibold text-ink">{t.title}</h1>
      <p className="mt-2 text-sm leading-5 text-ink-2">{t.description}</p>
      {error.digest ? (
        <p className="mt-2 font-mono text-xs tabular-nums text-muted">
          {t.reference}: {error.digest}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => reset()}>
          {t.retry}
        </Button>
        <Button href="/resumen">{MESSAGES.importar.volver}</Button>
      </div>
    </div>
  );
}
