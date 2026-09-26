"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Aviso } from "../../_lib/aviso";
import { Fila } from "./fila";
import { MESSAGES } from "./messages";
import type { FilaVista } from "./vista";

const t = MESSAGES;

/** Las teclas de la bandeja y el botón que pulsa cada una en la fila activa. */
const ACCIONES: Record<string, string> = { a: "a", e: "e", r: "r", s: "s" };

/** ¿La tecla viene de un campo de texto? Ahí escribir «a» es escribir una a. */
function escribiendo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * La lista de la bandeja de aprobación, con el teclado de Linear y
 * Superhuman: j y k mueven la fila activa (y el foco), a aprueba, e abre
 * el editor, r pide otra versión y s pregunta si saltar. El aviso de lo
 * último que pasó queda arriba aunque su fila ya no esté (al aprobarla,
 * sale de la lista), y el foco pasa a la fila que ocupa su lugar.
 */
export function Cola({ filas }: { filas: FilaVista[] }) {
  const [activa, setActiva] = useState<string | null>(filas[0]?.touchId ?? null);
  const [aviso, setAviso] = useState<string | null>(null);
  const indice = useRef(0);
  const ids = filas.map((f) => f.touchId);

  const enfocar = useCallback((id: string | undefined) => {
    if (!id) return;
    setActiva(id);
    const el = document.getElementById(`fila-${id}`);
    el?.focus();
    // jsdom no implementa scrollIntoView.
    el?.scrollIntoView?.({ block: "nearest" });
  }, []);

  // Si la fila activa salió de la lista (se aprobó, se saltó o la movió
  // otra persona), la activa pasa a la que ocupa su lugar.
  const clave = ids.join(",");
  useEffect(() => {
    if (activa && ids.includes(activa)) {
      indice.current = ids.indexOf(activa);
      return;
    }
    const siguiente = ids[Math.min(indice.current, ids.length - 1)];
    if (siguiente && aviso) enfocar(siguiente);
    else setActiva(siguiente ?? null);
  }, [clave]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || escribiendo(e.target) || ids.length === 0) return;
      const i = activa ? Math.max(0, ids.indexOf(activa)) : 0;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        enfocar(ids[e.key === "j" ? Math.min(i + 1, ids.length - 1) : Math.max(i - 1, 0)]);
        return;
      }
      const accion = ACCIONES[e.key];
      if (!accion || !activa) return;
      const boton = document.querySelector<HTMLElement>(`#fila-${activa} [data-accion="${accion}"] button`);
      if (!boton) return;
      e.preventDefault();
      boton.click();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activa, clave, enfocar]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid gap-4">
      <p className="text-xs text-ink-2" aria-label={t.atajos.label}>
        {t.atajos.items.map((a, n) => (
          <span key={a.key}>
            {n > 0 ? " · " : ""}
            <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[11px] text-ink">{a.key}</kbd> {a.text}
          </span>
        ))}
      </p>
      <Aviso notice={aviso} />
      <ul className="grid gap-4" role="list">
        {filas.map((f) => (
          <li key={f.touchId}>
            <Fila
              fila={f}
              activa={f.touchId === activa}
              onActivar={() => {
                indice.current = ids.indexOf(f.touchId);
                setActiva(f.touchId);
              }}
              onDone={(notice) => setAviso(notice)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
