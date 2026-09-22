"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/auth/messages";

/**
 * Lo que se ve cuando /cuenta no puede leer la sesión o la base: un
 * mensaje en español con un botón para reintentar, en vez de la página
 * genérica de Next en inglés. Mismo patrón que Finanzas.
 */
export default function CuentaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.cuentaError;

  useEffect(() => {
    console.error("[cuenta] error al leer la sesión", error);
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
