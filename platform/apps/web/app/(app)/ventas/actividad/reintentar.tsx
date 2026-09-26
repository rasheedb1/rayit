"use client";

import { useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reintentarPorTipo, type ActividadState } from "./actions";
import { MESSAGES } from "./messages";

export interface TipoReintentable {
  stepType: string;
  /** «Correo · 3», ya con la cifra formateada. */
  label: string;
}

/**
 * «Reintentar lo fallido» por tipo de paso, como la pestaña Queue de
 * Chief: un botón por tipo con cuántos fallidos puede de verdad volver a
 * la cola (el conteo sale de la misma regla de la base que el reintento,
 * así que ningún botón queda muerto), con la cadencia y el contacto que
 * filtra la pantalla.
 *
 * El resultado sube a `onResultado` (PanelActividad): después de
 * reintentar lo último este bloque desaparece, y el aviso sigue a la
 * vista. Sin tipos, no pinta nada.
 */
export function ReintentarPorTipo({
  tipos, sequenceId, contact, onResultado,
}: {
  tipos: TipoReintentable[];
  sequenceId: string | null;
  contact: string | null;
  onResultado: (r: ActividadState) => void;
}) {
  const [ocupado, empezar] = useTransition();
  const [cual, setCual] = useState<string | null>(null);
  const t = MESSAGES.reintentar;

  function reintentar(stepType: string) {
    setCual(stepType);
    empezar(async () => {
      const r = await reintentarPorTipo({ stepType, sequenceId, contact });
      setCual(null);
      onResultado(r);
    });
  }

  if (tipos.length === 0) return null;
  return (
    <section aria-labelledby="reintentar-titulo" className="rounded-md border border-line bg-surface p-3 sm:p-4">
      <h2 id="reintentar-titulo" className="text-sm font-semibold">{t.titulo}</h2>
      <p className="mt-1 text-xs text-fg-2">{t.ayuda}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {tipos.map((tipo) => (
          <Button
            key={tipo.stepType}
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={13} aria-hidden />}
            loading={ocupado && cual === tipo.stepType}
            disabled={ocupado}
            onClick={() => reintentar(tipo.stepType)}
          >
            {tipo.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
