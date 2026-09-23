"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { enviarCotizacion } from "../../actions";
import { MESSAGES } from "../../messages";

/**
 * «Enviar y copiar enlace». Hace las dos cosas que dice: envía (congela
 * el documento y mueve el negocio) y, con el enlace que devuelve la
 * acción, lo pone en el portapapeles. Si el navegador no deja copiar
 * (sin permiso o sin HTTPS), lo dice y deja el enlace a la vista para
 * copiarlo a mano: nunca se afirma «copiado» sin haberlo copiado.
 *
 * Al enviar, la página se vuelve a pintar como cotización enviada y este
 * botón desaparece; por eso el resultado viaja en la URL como un código
 * (?enviada=copiado | manual) y lo anuncia el detalle, no este botón.
 */
export function EnviarCotizacion({ id }: { id: string }) {
  const t = MESSAGES.detalle;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function enviar() {
    startTransition(async () => {
      const r = await enviarCotizacion(id);
      if (r.status === "error") {
        setError(r.message);
        return;
      }
      let copiado = false;
      try {
        await navigator.clipboard.writeText(new URL(r.path, window.location.origin).toString());
        copiado = true;
      } catch {
        copiado = false;
      }
      router.replace(`/cotizar/cotizaciones/${id}?enviada=${copiado ? "copiado" : "manual"}`);
    });
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <Button variant="primary" loading={pending} onClick={enviar}>
        {pending ? t.enviando : t.enviar}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-bad">
          {error}
        </span>
      )}
    </span>
  );
}
