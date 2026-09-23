"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./_lib/messages";
import { mostrarPistaDeDespliegue, useReintentar } from "./_lib/reintentar";

/**
 * La frontera de error del segmento (app): la que faltaba.
 *
 * Solo Finanzas tenía la suya, así que cualquier otra pantalla que
 * fallara en tiempo de petición —la portada con un DEMO_WORKSPACE_ID
 * que no corresponde a ninguna fila, por ejemplo— respondía 500 con el
 * documento genérico de Next, en inglés y fuera del marco de la
 * aplicación. Con este archivo, el error se ve DENTRO del Shell (la
 * barra lateral sigue ahí, se puede navegar a otro módulo) y en
 * español.
 *
 * Next exige que sea un componente cliente. «Reintentar» vuelve a
 * pedir el segmento al servidor (useReintentar: `reset()` solo, no lo
 * hacía); el error, entero, queda en el servidor.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.error;
  const { reintentar, pendiente } = useReintentar(reset);

  useEffect(() => {
    // En desarrollo Next ya lo muestra; en producción solo llega el digest.
    console.error("[app] la pantalla falló al renderizar", error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-xs text-fg-3">{t.eyebrow}</p>
      <h1 className="mt-2 text-xl font-semibold">{t.title}</h1>
      <p className="mt-2 text-sm leading-5 text-fg-2">{t.description}</p>
      <p className="mt-2 text-xs leading-5 text-fg-3">{t.hint}</p>
      {/* La pista de despliegue nombra variables del servidor: se la
          enseñamos a quien despliega (desarrollo y vistas previas de
          Vercel), no a quien entra. */}
      {mostrarPistaDeDespliegue() ? (
        <p className="mt-2 text-xs leading-5 text-fg-3">{t.hintDespliegue}</p>
      ) : null}
      {error.digest ? (
        <p className="mt-2 font-mono text-xs tabular-nums text-fg-3">
          {t.reference}: {error.digest}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={reintentar} loading={pendiente}>
          {t.retry}
        </Button>
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md border border-line px-4 text-sm font-medium text-fg-2 hover:border-line-2 hover:text-fg"
        >
          {t.home}
        </Link>
      </div>
    </div>
  );
}
