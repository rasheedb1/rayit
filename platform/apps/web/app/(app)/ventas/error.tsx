"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./_lib/messages";

/**
 * Lo que ve quien entra a Ventas cuando la base falla en tiempo de
 * petición: un mensaje en español con un botón para volver a
 * intentarlo, en vez de la página genérica de Next en inglés. Mismo
 * patrón que Finanzas, que es la pantalla de referencia.
 *
 * Next exige que sea un componente cliente. `reset()` vuelve a
 * renderizar el segmento; el error queda en la consola del servidor.
 */
export default function VentasError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.error;

  useEffect(() => {
    // En desarrollo Next ya lo muestra; en producción solo llega el digest.
    console.error("[ventas] error al leer la base", error);
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
        <Button variant="primary" onClick={() => reset()}>
          {t.retry}
        </Button>
      </div>
    </div>
  );
}
