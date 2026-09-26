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
 * Chief: un botón por tipo con cuántos fallidos reintentables tiene, con
 * la cadencia y el contacto que filtra la pantalla. El resultado se
 * anuncia (qué volvió a la cola y qué no, con su motivo).
 *
 * La pantalla lo monta siempre en la cola, también sin nada que
 * reintentar: así, después de reintentar lo último, el resultado sigue a
 * la vista. Sin tipos y sin resultado, no pinta nada.
 */
export function ReintentarPorTipo({
  tipos, sequenceId, contact,
}: { tipos: TipoReintentable[]; sequenceId: string | null; contact: string | null }) {
  const [estado, setEstado] = useState<ActividadState>({});
  const [ocupado, empezar] = useTransition();
  const [cual, setCual] = useState<string | null>(null);
  const t = MESSAGES.reintentar;

  function reintentar(stepType: string) {
    setCual(stepType);
    empezar(async () => {
      setEstado(await reintentarPorTipo({ stepType, sequenceId, contact }));
      setCual(null);
    });
  }

  if (tipos.length === 0 && !estado.ok && !estado.error) return null;
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
      <p role="status" aria-live="polite" className={`mt-2 text-xs ${estado.error ? "text-bad" : "text-fg-2"}`}>
        {estado.error ?? estado.ok ?? ""}
      </p>
    </section>
  );
}
