"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { enviarCotizacion } from "../../actions";
import { MESSAGES } from "../../messages";
import { ConfirmarAccion } from "../../_ui/confirmar-accion";

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
 * El detalle lo pinta una sola vez: AvisoEnviada borra el parámetro de
 * la URL, y recargar o compartir la dirección ya no repite «copiado».
 *
 * Con `confirmacion` —el negocio tiene otra versión que la marca puede
 * aceptar, y enviar esta la deja sin efecto (0033)—, enviar deja de ser
 * un clic: pide el mismo segundo paso que aceptar y rechazar, porque
 * tampoco se deshace (pulido r7).
 */
export function EnviarCotizacion({
  id,
  confirmacion,
}: {
  id: string;
  confirmacion?: { pregunta: string; consecuencia: string };
}) {
  const t = MESSAGES.detalle;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function enviarYCopiar() {
    setError(null);
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
  }

  const alerta = error && (
    <span role="alert" className="text-sm text-bad">
      {error}
    </span>
  );

  if (confirmacion) {
    // La acción del formulario de ConfirmarAccion: su botón «Sí, enviar…»
    // ya lleva el estado de carga (useFormStatus), así que un doble clic
    // no envía dos veces.
    return (
      <span className="flex flex-col items-start gap-1">
        <ConfirmarAccion
          action={enviarYCopiar}
          label={t.enviar}
          variant="primary"
          anchoAbierta="w-full sm:w-80"
          pregunta={confirmacion.pregunta}
          consecuencia={confirmacion.consecuencia}
          confirmar={t.confirmar.enviar.boton}
          cancelar={t.confirmar.cancelar}
        />
        {alerta}
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <Button variant="primary" loading={pending} onClick={() => startTransition(enviarYCopiar)}>
        {pending ? t.enviando : t.enviar}
      </Button>
      {alerta}
    </span>
  );
}
