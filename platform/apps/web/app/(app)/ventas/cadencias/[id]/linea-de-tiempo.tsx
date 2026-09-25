"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Aviso } from "../../../_lib/aviso";
import { anadirPaso, quitarPaso, reordenarPasos } from "../actions";
import { IconoCanal } from "../canal";
import { MESSAGES } from "../messages";
import { EditorPaso } from "./editor-paso";
import { TarjetaPaso, type PasoVista } from "./tarjeta-paso";

type Opcion = { value: string; label: string };
/** Dónde tiene que volver el foco tras un cambio: el botón de esa tarjeta que lo tenía. */
type Foco = { id: string; accion: "subir" | "bajar" | "editar" };

/**
 * La línea de tiempo editable (VEN-13), como la secuencia de Lemlist e
 * Instantly: un riel vertical con un nodo por paso (el icono de su
 * canal), la tarjeta del paso al lado y, entre dos tarjetas, lo que se
 * espera («Espera 2 días hábiles»). La edición es en el sitio, como en
 * Linear.
 *
 * Reordenar se hace arrastrando (ratón) o con Subir y Bajar (teclado y
 * pantallas táctiles, donde arrastrar no existe). Los días se quedan en
 * su sitio y los mensajes se mueven, como en Lemlist: el paso que baja al
 * tercer puesto toma el día del tercer puesto. Mientras el servidor
 * guarda, la lista ya se ve en su orden nuevo (useOptimistic); si falla,
 * vuelve sola y el motivo queda arriba.
 *
 * El foco no se pierde: tras mover, vuelve al botón que se usó (o al
 * otro, si ese quedó en el borde, o al título del paso); tras cerrar el
 * editor con Guardar, Cancelar o Escape, vuelve a su «Editar».
 */
export function LineaDeTiempo({
  sequenceId,
  pasos,
  estructura,
  editable,
  angulos,
  tipos,
  canales,
}: {
  sequenceId: string;
  pasos: PasoVista[];
  /** Día, canal, orden y número de pasos se pueden cambiar (nadie dentro, sin archivar). */
  estructura: boolean;
  /** El texto se puede cambiar (sin archivar). */
  editable: boolean;
  angulos: Opcion[];
  tipos: Opcion[];
  /** Las redes de una tarea a mano. */
  canales: Opcion[];
}) {
  const t = MESSAGES.paso;
  const [vista, moverOptimista] = useOptimistic(pasos, (actual: PasoVista[], orden: string[]) => {
    const porId = new Map(actual.map((p) => [p.id, p]));
    // El día es del puesto, no del mensaje: cada puesto conserva el suyo (y su espera, y su número).
    return orden.map((id, i) => ({
      ...porId.get(id)!,
      numero: actual[i]!.numero,
      diaLabel: actual[i]!.diaLabel,
      esperaLabel: actual[i]!.esperaLabel,
      dayOffset: actual[i]!.dayOffset,
    }));
  });
  const [editando, setEditando] = useState<string | null>(null);
  const [arrastrado, setArrastrado] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  /** Lo que una acción quiere decir sin ser error (el paso añadido como gesto porque la política ya está llena). */
  const [info, setInfo] = useState<string | undefined>();
  const [anuncio, setAnuncio] = useState("");
  const [foco, setFoco] = useState<Foco | null>(null);
  const [pending, start] = useTransition();
  const listaRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!foco || editando === foco.id) return;
    const tarjeta = listaRef.current?.querySelector(`[data-paso="${foco.id}"]`);
    const boton = (accion: string) => tarjeta?.querySelector<HTMLButtonElement>(`[data-accion="${accion}"] button`);
    const otro = foco.accion === "subir" ? "bajar" : foco.accion === "bajar" ? "subir" : null;
    const destino = [boton(foco.accion), otro ? boton(otro) : null].find((b) => b && !b.disabled) ?? tarjeta?.querySelector<HTMLElement>("h3");
    destino?.focus();
    // Mientras se guarda, el servidor puede volver a pintar la lista: el foco se repone hasta que termine.
    if (!pending) setFoco(null);
  }, [foco, vista, pending, editando]);

  function reordenar(orden: string[], movido: string) {
    setError(undefined);
    start(async () => {
      moverOptimista(orden);
      const r = await reordenarPasos(sequenceId, orden);
      if (r.error) setError(r.error);
      else setAnuncio(t.movido(pasos.find((p) => p.id === movido)?.numero ?? "", String(orden.indexOf(movido) + 1)));
    });
  }

  function mover(id: string, direccion: -1 | 1) {
    if (pending) return;
    const orden = vista.map((p) => p.id);
    const i = orden.indexOf(id);
    const j = i + direccion;
    if (i < 0 || j < 0 || j >= orden.length) return;
    [orden[i], orden[j]] = [orden[j]!, orden[i]!];
    setFoco({ id, accion: direccion === -1 ? "subir" : "bajar" });
    reordenar(orden, id);
  }

  function soltarSobre(destino: string) {
    if (!arrastrado || arrastrado === destino || pending) return;
    const orden = vista.map((p) => p.id).filter((id) => id !== arrastrado);
    const baja = vista.findIndex((p) => p.id === arrastrado) < vista.findIndex((p) => p.id === destino);
    orden.splice(orden.indexOf(destino) + (baja ? 1 : 0), 0, arrastrado);
    setArrastrado(null);
    reordenar(orden, arrastrado);
  }

  function actuar(fn: () => Promise<{ error?: string; ok?: string }>) {
    setError(undefined);
    setInfo(undefined);
    start(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      else if (r.ok) setInfo(r.ok);
    });
  }

  function cerrarEditor(id: string) {
    setEditando(null);
    setFoco({ id, accion: "editar" });
  }

  return (
    <section aria-labelledby="linea" aria-busy={pending || undefined}>
      <h2 id="linea" className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-3">
        {MESSAGES.detalle.pasos}
      </h2>
      <Aviso message={error} info={info} className="mb-3" />
      <p aria-live="polite" className="sr-only">
        {pending ? t.moviendo : anuncio}
      </p>
      <ol ref={listaRef}>
        {vista.map((paso, i) => {
          const siguiente = vista[i + 1];
          const marcado = editando === paso.id || arrastrado === paso.id;
          return (
            <li
              key={paso.id}
              onDragOver={(e) => {
                if (arrastrado) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                soltarSobre(paso.id);
              }}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3"
            >
              {/* El riel: un tramo que llega del paso anterior, el nodo con el canal y un tramo hacia el siguiente. */}
              <div aria-hidden="true" className="flex flex-col items-center">
                <span className={`h-3 w-px ${i === 0 ? "" : "bg-line"}`} />
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-full border bg-surface ${
                    marcado ? "border-accent text-accent" : "border-line text-fg-2"
                  }`}
                >
                  <IconoCanal canal={paso.channel} tipo={paso.stepType} />
                </span>
                {siguiente && <span className="w-px flex-1 bg-line" />}
              </div>
              <div className={`min-w-0 ${arrastrado === paso.id ? "opacity-50" : ""}`}>
                {editando === paso.id ? (
                  <EditorPaso
                    sequenceId={sequenceId}
                    paso={paso}
                    estructura={estructura}
                    angulos={angulos}
                    tipos={tipos}
                    canales={canales}
                    onDone={() => cerrarEditor(paso.id)}
                  />
                ) : (
                  <TarjetaPaso
                    paso={paso}
                    primero={i === 0}
                    ultimo={i === vista.length - 1}
                    mover={(d) => mover(paso.id, d)}
                    editar={() => setEditando(paso.id)}
                    quitar={async () => actuar(() => quitarPaso(sequenceId, paso.id))}
                    arrastrable={estructura}
                    ocupado={pending}
                    editable={editable}
                    onDragStart={() => setArrastrado(paso.id)}
                    onDragEnd={() => setArrastrado(null)}
                  />
                )}
                {siguiente &&
                  (siguiente.esperaLabel ? (
                    <p className="py-2.5 text-xs tabular-nums text-fg-3">{siguiente.esperaLabel}</p>
                  ) : (
                    <div className="h-3" />
                  ))}
              </div>
            </li>
          );
        })}
      </ol>
      {estructura && (
        <div className="mt-3 pl-10">
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={14} aria-hidden="true" />}
            loading={pending}
            onClick={() => actuar(() => anadirPaso(sequenceId))}
          >
            {t.anadir}
          </Button>
        </div>
      )}
    </section>
  );
}
