"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./_lib/messages";

/** Cuánto dura el «Copiado» antes de volver al texto del botón. */
const COPIED_MS = 2000;

/**
 * Copia el correo al portapapeles y lo anuncia. Es lo único de cliente
 * de la bandeja: el asunto y el cuerpo los redactó el job y los pinta
 * el servidor.
 *
 * Gemelo de campanas/[id]/copiar.tsx, que copia un código de una línea.
 * No se comparte todavía para no tocar dos módulos en la misma historia;
 * promoverlos al kit es un pulido (ver docs/propuestas/FIN-4.md §2).
 */
export function CopiarCorreo({ asunto, cuerpo, etiqueta }: { asunto: string; cuerpo: string; etiqueta: string }) {
  const [estado, setEstado] = useState<"quieto" | "copiado" | "falló">("quieto");
  const t = MESSAGES.bandeja;

  useEffect(() => {
    if (estado === "quieto") return;
    const id = setTimeout(() => setEstado("quieto"), COPIED_MS);
    return () => clearTimeout(id);
  }, [estado]);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(`${asunto}\n\n${cuerpo}`);
      setEstado("copiado");
    } catch {
      setEstado("falló");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onClick={copiar} aria-label={`${t.copiar}: ${etiqueta}`}>
        {estado === "copiado" ? t.copiado : t.copiar}
      </Button>
      <span role="status" aria-live="polite" className="text-xs text-fg-3">
        {estado === "copiado" && t.copiadoAviso}
        {estado === "falló" && t.copiarFalló}
      </span>
    </span>
  );
}
