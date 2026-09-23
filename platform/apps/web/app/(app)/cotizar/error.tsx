"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./messages";

/**
 * Lo que ve el creador cuando la base falla en tiempo de petición: un
 * mensaje en español con un botón para reintentar, en vez de la página
 * genérica de Next en inglés. Cubre todo el segmento /cotizar.
 */
export default function CotizarError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.error;

  useEffect(() => {
    console.error("[cotizar] error al leer la base", error);
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
