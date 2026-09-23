"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/auth/messages";

/**
 * Lo que se ve cuando /login no puede pintarse: `searchParams` o la
 * cabecera de la petición que lanzan, o la server action del
 * formulario. (Desde la ronda 4 la página ya no pregunta por la
 * sesión: con Supabase caído, /login se pinta igual.)
 *
 * Es la única pantalla del producto que ve alguien que todavía no ha
 * entrado, así que caer en la página genérica de Next —en inglés, sin
 * marca— es justo lo que no puede pasar aquí. Mismo patrón que Finanzas
 * y que /cuenta.
 */
export default function LoginError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = MESSAGES.loginError;

  useEffect(() => {
    console.error("[login] no se pudo pintar la pantalla de acceso", error);
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
    </main>
  );
}
