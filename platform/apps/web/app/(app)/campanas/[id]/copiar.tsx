"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Cuánto dura el «Copiado» antes de volver al texto del botón. */
const COPIED_MS = 2000;

/**
 * Copia un texto al portapapeles y lo anuncia. Es lo único de cliente
 * en la sección de seguimiento: el código y el enlace se pintan en el
 * servidor.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(id);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={copy} aria-label={`${label}: copiar`}>
        {state === "copied" ? "Copiado" : "Copiar"}
      </Button>
      <span role="status" aria-live="polite" className="text-xs text-fg-3">
        {state === "copied" && `${label} copiado`}
        {state === "failed" && "No se pudo copiar: selecciónalo y cópialo a mano"}
      </span>
    </span>
  );
}
