"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { escribiendo } from "@/lib/teclado";
import { Aviso } from "../../_lib/aviso";
import { deshacerAprobacion, type Deshacer, type ResultadoAprobacion } from "./actions";
import { Fila } from "./fila";
import { MESSAGES } from "./messages";
import type { FilaVista } from "./vista";

const t = MESSAGES;

/** Las teclas que pulsan un botón de la fila activa (su `data-accion`). */
const TECLAS_DE_ACCION: ReadonlySet<string> = new Set(["a", "e", "r", "s"]);
/** Cuánto tiempo se ofrece «Deshacer» después de aprobar. */
export const DESHACER_MS = 10_000;

/** Lo último que pasó: el aviso y, si fue una aprobación, cómo deshacerla. */
type Ultimo = { notice: string; deshacer: Deshacer | null } | { error: string };

/**
 * ¿La fila tiene algo abierto que espera una respuesta: la pregunta de
 * «Saltar», el editor o la pista de «Regenerar»? Los tres son un form
 * (ConfirmInline del kit pinta el suyo al abrirse; mirarlo desde fuera
 * evita cambiar su API). Entonces una letra no es un atajo: con «¿Saltar
 * este paso?» abierto, la «a» aprobaba el mensaje que se iba a saltar, y
 * la «s» pulsaba «Sí, saltar».
 */
function filaOcupada(touchId: string): boolean {
  return document.querySelector(`#fila-${touchId} form`) !== null;
}

/**
 * La lista de la bandeja de aprobación, con el teclado de Linear y
 * Superhuman: j y k mueven la fila activa (y el foco), a aprueba, e abre
 * el editor, r pide otra versión y s pregunta si saltar. Con una
 * confirmación o un formulario abiertos en la fila activa, a, e, r y s no
 * hacen nada: se responde lo que está abierto (o se cierra con Escape).
 * Quien solo mira (sin PUEDEN_OPERAR_VENTAS) tiene j y k. La lista está
 * siempre montada, también vacía: el aviso de lo último que pasó queda
 * arriba aunque su fila ya no esté (al aprobar la última, la cola pasa a
 * «Nada por aprobar» y el aviso sigue ahí), con «Deshacer» durante unos
 * segundos. El foco pasa a la fila que ocupa el lugar de la que salió.
 */
export function Cola({ filas, puedeOperar = true }: { filas: FilaVista[]; puedeOperar?: boolean }) {
  const [activa, setActiva] = useState<string | null>(filas[0]?.touchId ?? null);
  const [ultimo, setUltimo] = useState<Ultimo | null>(null);
  const [puedeDeshacer, setPuedeDeshacer] = useState(false);
  const [deshaciendo, startDeshacer] = useTransition();
  const indice = useRef(0);
  // Los ids y la activa, en refs: el oyente del teclado se registra una vez y siempre lee lo último.
  const ids = filas.map((f) => f.touchId);
  const idsRef = useRef(ids);
  const activaRef = useRef(activa);
  const huboAviso = useRef(false);
  const operarRef = useRef(puedeOperar);
  useLayoutEffect(() => {
    idsRef.current = ids;
    activaRef.current = activa;
    huboAviso.current = ultimo !== null;
    operarRef.current = puedeOperar;
  });

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
    const lista = idsRef.current;
    const actual = activaRef.current;
    if (actual && lista.includes(actual)) {
      indice.current = lista.indexOf(actual);
      return;
    }
    const siguiente = lista[Math.min(indice.current, lista.length - 1)];
    if (siguiente && huboAviso.current) enfocar(siguiente);
    else setActiva(siguiente ?? null);
  }, [clave, enfocar]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const lista = idsRef.current;
      // Lo que ya atendió otro (Escape en una confirmación abierta) no es un atajo.
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || escribiendo(e.target) || lista.length === 0) return;
      const actual = activaRef.current;
      const i = actual ? Math.max(0, lista.indexOf(actual)) : 0;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        enfocar(lista[e.key === "j" ? Math.min(i + 1, lista.length - 1) : Math.max(i - 1, 0)]);
        return;
      }
      if (!TECLAS_DE_ACCION.has(e.key) || !actual || !operarRef.current) return;
      if (filaOcupada(actual)) return;
      const boton = document.querySelector<HTMLElement>(`#fila-${actual} [data-accion="${e.key}"] button`);
      if (!boton) return;
      e.preventDefault();
      boton.click();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enfocar]);

  // «Deshacer» se ofrece unos segundos, como en Superhuman.
  useEffect(() => {
    if (!puedeDeshacer) return;
    const id = window.setTimeout(() => setPuedeDeshacer(false), DESHACER_MS);
    return () => window.clearTimeout(id);
  }, [puedeDeshacer, ultimo]);

  function hecho(r: Extract<ResultadoAprobacion, { ok: true }>) {
    setUltimo({ notice: r.notice, deshacer: r.deshacer ?? null });
    setPuedeDeshacer(r.deshacer !== undefined && r.deshacer !== null);
  }

  function deshacer(d: Deshacer) {
    startDeshacer(async () => {
      const r = await deshacerAprobacion(d);
      setPuedeDeshacer(false);
      setUltimo(r.ok ? { notice: r.notice, deshacer: null } : { error: r.message ?? t.errores.generico });
    });
  }

  const regenerables = filas.some((f) => f.regenerable);
  const atajos = t.atajos.items.filter((a) =>
    puedeOperar ? a.key !== "r" || regenerables : a.key === "j" || a.key === "k",
  );
  const deshacible = ultimo && "notice" in ultimo && puedeDeshacer ? ultimo.deshacer : null;

  return (
    <div className="grid gap-4">
      {filas.length > 0 ? (
        // Sin teclado (un teléfono) la leyenda no sirve: solo desde sm.
        <p className="hidden text-xs text-ink-2 sm:block" aria-label={t.atajos.label}>
          {atajos.map((a, n) => (
            <span key={a.key}>
              {n > 0 ? " · " : ""}
              <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[11px] text-ink">{a.key}</kbd> {a.text}
            </span>
          ))}
        </p>
      ) : null}
      {ultimo ? (
        <div className="flex flex-wrap items-center gap-3">
          <Aviso
            className="flex-1"
            notice={"notice" in ultimo ? ultimo.notice : null}
            message={"error" in ultimo ? ultimo.error : null}
          />
          {deshacible ? (
            <Button size="sm" variant="secondary" loading={deshaciendo} onClick={() => deshacer(deshacible)}>
              {t.avisos.deshacer}
            </Button>
          ) : null}
        </div>
      ) : null}
      {filas.length === 0 ? (
        <EmptyState title={t.vacio.title} description={t.vacio.description} action={{ label: t.vacio.action, href: "/ventas/cadencias" }} />
      ) : (
        <ul className="grid gap-4" role="list">
          {filas.map((f) => (
            <li key={f.touchId}>
              <Fila
                fila={f}
                activa={f.touchId === activa}
                puedeOperar={puedeOperar}
                onActivar={() => {
                  indice.current = ids.indexOf(f.touchId);
                  setActiva(f.touchId);
                }}
                onDone={hecho}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
