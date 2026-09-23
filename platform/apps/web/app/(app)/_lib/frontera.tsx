"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./messages";
import { mostrarPistaDeDespliegue, useReintentar } from "./reintentar";

/** Lo que un módulo puede afinar de su frontera: de qué módulo es y qué no se pudo leer. */
export interface TituloDeFrontera {
  eyebrow: string;
  title: string;
}

/**
 * La frontera de error de la aplicación, una sola vez.
 *
 * La ronda 3 tenía tres copias —(app), Finanzas y Ventas— y se habían
 * separado: las de módulo decían «la base de datos no respondió a
 * tiempo o rechazó la conexión» también cuando lo que pasaba es que
 * DEMO_WORKSPACE_ID apuntaba a un workspace que no existe (la base sí
 * contestó; la configuración está mal), no daban la pista de despliegue
 * y no ofrecían volver al plan. Quien desplegaba iba a buscar un
 * problema de red.
 *
 * Ahora cada módulo pone su nombre y su título, y lo demás —las dos
 * causas posibles, la pista para quien despliega, «Reintentar» que de
 * verdad pide al servidor, la salida al plan y la referencia— es el
 * mismo en todas.
 */
export function FronteraDeError({
  error,
  reset,
  titulo,
  origen,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Por omisión, el del segmento (app). */
  titulo?: TituloDeFrontera;
  /** Para el log del servidor: «[finanzas] la pantalla falló…». */
  origen: string;
}) {
  const t = MESSAGES.error;
  const { eyebrow, title } = titulo ?? t;
  const { reintentar, pendiente } = useReintentar(reset);

  useEffect(() => {
    // En desarrollo Next ya lo muestra; en producción solo llega el digest.
    console.error(`[${origen}] la pantalla falló al renderizar`, error);
  }, [error, origen]);

  return (
    <div role="alert" className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-xs text-fg-3">{eyebrow}</p>
      <h1 className="mt-2 text-xl font-semibold text-fg">{title}</h1>
      <p className="mt-2 text-sm leading-5 text-fg-2">{t.description}</p>
      <p className="mt-2 text-xs leading-5 text-fg-3">{t.hint}</p>
      {/* La pista de despliegue nombra variables del servidor: se la
          enseñamos a quien despliega (desarrollo y vistas previas de
          Vercel), no a quien entra. */}
      {mostrarPistaDeDespliegue() ? <p className="mt-2 text-xs leading-5 text-fg-3">{t.hintDespliegue}</p> : null}
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
