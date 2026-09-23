"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "./messages";

/**
 * Copia un enlace al portapapeles y lo dice.
 *
 * La ruta llega relativa ("/kit/abc") y se vuelve absoluta aquí, en el
 * navegador: el servidor no conoce el dominio con el que entró la
 * visita, y adivinarlo con una variable de entorno es la forma clásica
 * de repartir enlaces a localhost.
 */
export function CopiarEnlace({ path, label, size = "sm" }: { path: string; label?: string; size?: "sm" | "md" }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    const url = new URL(path, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Sin permiso de portapapeles (o sin HTTPS): al menos que se vea.
      window.prompt(MESSAGES.detalle.enlace, url);
      return;
    }
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <Button size={size} onClick={copiar} aria-live="polite">
      {copiado ? MESSAGES.detalle.copiado : (label ?? MESSAGES.detalle.copiar)}
    </Button>
  );
}
