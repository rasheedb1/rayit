"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./_lib/messages";
import { useReintentar } from "../_lib/reintentar";

/**
 * Lo que ve quien entra a Finanzas cuando la base falla en tiempo de
 * petición (DATABASE_URL inválida, statement_timeout, DEMO_WORKSPACE_ID
 * que no es UUID…): un mensaje en español con un botón para volver a
 * intentarlo, en vez de la página genérica de Next en inglés.
 *
 * Next exige que sea un componente cliente. «Reintentar» vuelve a
 * pedir el segmento al servidor (useReintentar: `reset()` solo
 * re-renderizaba el error que ya tenía); el error queda en la consola
 * del servidor.
 */
export default function FinanzasError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.error;
  const { reintentar, pendiente } = useReintentar(reset);

  useEffect(() => {
    // En desarrollo Next ya lo muestra; en producción solo llega el digest.
    console.error("[finanzas] error al leer la base", error);
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
      <div className="mt-6">
        <Button variant="primary" onClick={reintentar} loading={pendiente}>
          {t.retry}
        </Button>
      </div>
    </div>
  );
}
