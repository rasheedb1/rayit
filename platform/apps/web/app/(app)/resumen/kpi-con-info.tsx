"use client";

import { useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Kpi, type KpiProps } from "@/components/ui/kpi";

/**
 * Un Kpi del kit con un botón (i) en la esquina: la tarjeta enseña solo
 * la cifra, el delta y la sparkline, y lo que explica de dónde sale la
 * cifra —la base de videos, las cuentas nuevas, hasta qué día suma— se
 * abre al pulsarlo.
 *
 * Es un patrón de divulgación (botón con aria-expanded que abre un panel
 * que controla), no un tooltip de `title`: `title` no se ve con el dedo
 * ni con el teclado, y el lector de pantalla no siempre lo lee. El panel
 * se cierra con Escape, al volver a pulsar o al sacar el foco de la
 * tarjeta.
 *
 * Envuelve al Kpi en vez de cambiar su API: el kit es de Nicolás, y esto
 * es una decisión de Resumen. Si otro módulo lo quiere, se propone allí.
 */
export function KpiConInfo({ info, infoLabel, ...kpi }: KpiProps & { info: string[]; infoLabel: string }) {
  const [abierto, setAbierto] = useState(false);
  const panelId = useId();
  const boton = useRef<HTMLButtonElement>(null);

  if (info.length === 0 || kpi.loading) return <Kpi {...kpi} />;

  const alSalir = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAbierto(false);
  };
  const alTeclear = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && abierto) {
      e.stopPropagation();
      setAbierto(false);
      boton.current?.focus();
    }
  };

  return (
    <div className="relative flex min-w-0 bg-surface" onBlur={alSalir} onKeyDown={alTeclear}>
      <Kpi {...kpi} className={`flex-1 pr-10 ${kpi.className ?? ""}`} />
      <button
        ref={boton}
        type="button"
        aria-label={infoLabel}
        aria-expanded={abierto}
        aria-controls={panelId}
        onClick={() => setAbierto((a) => !a)}
        className="absolute right-2 top-2.5 grid h-6 w-6 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v4M8 4.75v.01" strokeLinecap="round" />
        </svg>
      </button>
      <div
        id={panelId}
        hidden={!abierto}
        className="absolute inset-x-2 top-10 z-10 space-y-1.5 rounded-md border border-border bg-surface px-3 py-2.5 text-xs leading-relaxed text-ink-2 shadow-sm"
      >
        {info.map((frase) => (
          <p key={frase}>{frase}</p>
        ))}
      </div>
    </div>
  );
}
