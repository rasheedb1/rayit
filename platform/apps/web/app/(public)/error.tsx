"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/app/(app)/cotizar/messages";

/**
 * Lo que ve la marca si la base falla al abrir un media kit o una
 * cotización: un mensaje en español, en la misma voz del documento y
 * sin la navegación del creador, en vez de la página genérica de Next
 * en inglés. Mismo patrón que el error.tsx de Finanzas.
 */
export default function PublicoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.publico.error;

  useEffect(() => {
    console.error("[enlace público] error al abrir el documento", error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-xl font-semibold text-ink">{t.title}</h1>
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
