"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Aviso } from "../../../_lib/aviso";
import { anadirPaso, quitarPaso, reordenarPasos } from "../actions";
import { MESSAGES } from "../messages";
import { EditorPaso } from "./editor-paso";
import { TarjetaPaso, type PasoVista } from "./tarjeta-paso";

/**
 * La línea de tiempo editable (VEN-13): un paso por tarjeta, en el orden
 * en que salen. Referencias: la secuencia de Lemlist e Instantly (una
 * columna de pasos con su día y su canal, arrastrables) y Linear para
 * editar en el sitio.
 *
 * Reordenar se hace arrastrando (ratón) o con Subir y Bajar (teclado y
 * pantallas táctiles, donde arrastrar no existe). Los días se quedan en
 * su sitio y los mensajes se mueven, como en Lemlist: el paso que baja al
 * tercer puesto toma el día del tercer puesto. Mientras el servidor
 * guarda, la lista ya se ve en su orden nuevo (useOptimistic); si falla,
 * vuelve sola y el motivo queda arriba.
 */
export function LineaDeTiempo({
  sequenceId,
  pasos,
  estructura,
  editable,
  angulos,
  tipos,
}: {
  sequenceId: string;
  pasos: PasoVista[];
  /** Día, canal, orden y número de pasos se pueden cambiar (nadie dentro, sin archivar). */
  estructura: boolean;
  /** El texto se puede cambiar (sin archivar). */
  editable: boolean;
  angulos: { value: string; label: string }[];
  tipos: { value: string; label: string }[];
}) {
  const t = MESSAGES.paso;
  const [vista, moverOptimista] = useOptimistic(pasos, (actual: PasoVista[], orden: string[]) => {
    const porId = new Map(actual.map((p) => [p.id, p]));
    // El día es del puesto, no del mensaje: cada puesto conserva el suyo.
    return orden.map((id, i) => ({ ...porId.get(id)!, numero: actual[i]!.numero, diaLabel: actual[i]!.diaLabel }));
  });
  const [editando, setEditando] = useState<string | null>(null);
  const [arrastrado, setArrastrado] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [anuncio, setAnuncio] = useState("");
  const [pending, start] = useTransition();

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
    const orden = vista.map((p) => p.id);
    const i = orden.indexOf(id);
    const j = i + direccion;
    if (i < 0 || j < 0 || j >= orden.length) return;
    [orden[i], orden[j]] = [orden[j]!, orden[i]!];
    reordenar(orden, id);
  }

  function soltarSobre(destino: string) {
    if (!arrastrado || arrastrado === destino) return;
    const orden = vista.map((p) => p.id).filter((id) => id !== arrastrado);
    orden.splice(orden.indexOf(destino) + (vista.findIndex((p) => p.id === arrastrado) < vista.findIndex((p) => p.id === destino) ? 1 : 0), 0, arrastrado);
    setArrastrado(null);
    reordenar(orden, arrastrado);
  }

  function actuar(fn: () => Promise<{ error?: string }>) {
    setError(undefined);
    start(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
    });
  }

  return (
    <section aria-labelledby="linea" aria-busy={pending || undefined}>
      <h2 id="linea" className="sr-only">
        {MESSAGES.detalle.flujo}
      </h2>
      <Aviso message={error} className="mb-3" />
      <p aria-live="polite" className="sr-only">
        {pending ? t.moviendo : anuncio}
      </p>
      <ol className="grid gap-3">
        {vista.map((paso, i) => (
          <li
            key={paso.id}
            onDragOver={(e) => {
              if (arrastrado) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              soltarSobre(paso.id);
            }}
            className={arrastrado === paso.id ? "opacity-50" : undefined}
          >
            {editando === paso.id ? (
              <EditorPaso
                sequenceId={sequenceId}
                paso={paso}
                estructura={estructura}
                angulos={angulos}
                tipos={tipos}
                onDone={() => setEditando(null)}
              />
            ) : (
              <TarjetaPaso
                paso={paso}
                primero={i === 0}
                ultimo={i === vista.length - 1}
                mover={(d) => mover(paso.id, d)}
                editar={() => setEditando(paso.id)}
                quitar={async () => actuar(() => quitarPaso(sequenceId, paso.id))}
                arrastrable={estructura && !pending}
                editable={editable}
                onDragStart={() => setArrastrado(paso.id)}
                onDragEnd={() => setArrastrado(null)}
              />
            )}
          </li>
        ))}
      </ol>
      {estructura && (
        <div className="mt-3">
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
