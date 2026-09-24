"use client";

import { useEffect } from "react";
import { Marca } from "@/components/marca";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "../messages";

/**
 * Si la base falla al abrir /baja/<token> (VEN-15 r4). La frontera de
 * (public) es la de Cotizar y habla de «documentos»; quien solo quiere
 * dejar de recibir correos necesita otra cosa: qué pasó, reintentar, y la
 * salida que siempre funciona, responder al correo. Mismo patrón que el
 * error.tsx de Finanzas.
 */
export default function BajaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.errorPagina;

  useEffect(() => {
    console.error("[baja] error al abrir el enlace de baja", error);
  }, [error]);

  return (
    <div className="py-10 md:py-16">
      <Marca />
      <div role="alert">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t.title}</h1>
        <p className="mt-3 text-base leading-relaxed text-ink-2">{t.body}</p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs tabular-nums text-muted">
            {t.reference}: {error.digest}
          </p>
        ) : null}
      </div>
      <div className="mt-6">
        <Button variant="primary" onClick={() => reset()}>
          {t.retry}
        </Button>
      </div>
    </div>
  );
}
