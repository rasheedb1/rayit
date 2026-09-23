"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/auth/messages";

/**
 * El límite de error de la RAÍZ: cubre lo que vive fuera del grupo
 * (app) —/auth/callback, /legal y cualquier ruta futura que no lleve
 * marco— y hace de red por debajo de los error.tsx de cada segmento.
 *
 * Sin él, una excepción en esas rutas cae en la pantalla por defecto de
 * Next, en inglés y sin marca. No es global-error.tsx a propósito: ese
 * reemplaza el <html> entero y se lleva por delante el tema y las
 * fuentes; este se pinta dentro del layout de la raíz, que es lo que se
 * quiere.
 */
export default function ErrorRaiz({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.errorRaiz;

  useEffect(() => {
    console.error("[app] error sin capturar", error);
  }, [error]);

  return (
    <main role="alert" className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12 text-center">
      <p className="font-mono text-xs text-muted">{t.eyebrow}</p>
      <h1 className="mt-2 text-xl font-semibold text-ink">{t.titulo}</h1>
      <p className="mt-2 text-sm leading-5 text-ink-2">{t.descripcion}</p>
      {error.digest ? (
        <p className="mt-2 font-mono text-xs tabular-nums text-muted">
          {t.referencia}: {error.digest}
        </p>
      ) : null}
      <div className="mt-6 flex justify-center">
        <Button variant="primary" onClick={() => reset()}>
          {t.reintentar}
        </Button>
      </div>
      <p className="mt-6 text-xs text-muted">
        <Link href="/resumen" className="underline underline-offset-4 hover:text-ink">
          {t.inicio}
        </Link>
      </p>
    </main>
  );
}
