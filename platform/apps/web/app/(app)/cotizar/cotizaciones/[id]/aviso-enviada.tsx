"use client";

import { useEffect } from "react";
import { CopiarEnlace } from "../../copiar-enlace";
import { MESSAGES } from "../../messages";

/**
 * El aviso que sigue a «Enviar y copiar enlace», de un solo uso.
 *
 * El resultado de enviar llega en la URL (?enviada=copiado | manual)
 * porque el botón desaparece cuando la página vuelve pintada como
 * enviada. Pero un parámetro que se queda en la URL se repite al
 * recargar o al compartir la dirección, y entonces «enlace copiado»
 * afirma algo que en esa visita no pasó. Por eso, en cuanto se pinta, el
 * parámetro se quita de la barra con `history.replaceState`: Next lo
 * integra con su router sin volver a pedir la página, así que el aviso
 * sigue a la vista ahora y no vuelve en la próxima carga. Los demás
 * parámetros de la URL se conservan.
 */
export function AvisoEnviada({ enviada, enlace }: { enviada: "copiado" | "manual"; enlace: string }) {
  const t = MESSAGES.detalle;

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("enviada")) return;
    url.searchParams.delete("enviada");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-good/30 bg-good-wash px-3 py-2 text-sm">
      <span className="font-medium text-good">{enviada === "copiado" ? t.enviadaCopiado : t.enviadaSinCopiar}</span>
      {enviada === "manual" && <CopiarEnlace path={enlace} />}
    </div>
  );
}
