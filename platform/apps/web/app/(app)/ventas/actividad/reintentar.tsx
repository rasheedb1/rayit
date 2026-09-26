"use client";

import { ConfirmInline } from "@/components/ui/confirm-inline";
import { reintentarPorTipo, type ActividadState } from "./actions";
import { MESSAGES } from "./messages";

export interface TipoReintentable {
  stepType: string;
  /** «Correo · 3», ya con la cifra formateada. */
  label: string;
  /** «¿Volver a enviar 3 mensajes de Correo?»: lo que pregunta antes de reintentar. */
  pregunta: string;
}

/**
 * «Reintentar lo fallido» por tipo de paso, como la pestaña Queue de
 * Chief: un botón por tipo con cuántos fallidos puede de verdad volver a
 * la cola (el conteo sale de la misma regla de la base que el reintento,
 * así que ningún botón queda muerto), con la cadencia y el contacto que
 * filtra la pantalla.
 *
 * Es una acción en masa (hasta BULK_MAX mensajes a marcas de un clic),
 * así que pregunta antes, como «Cancelar seleccionados»: cuántos y de qué
 * tipo, y cuándo salen. El resultado sube a `onResultado`
 * (PanelActividad): después de reintentar lo último este bloque
 * desaparece, y el aviso sigue a la vista. Sin tipos, no pinta nada.
 */
export function ReintentarPorTipo({
  tipos, sequenceId, contact, ayuda = MESSAGES.reintentar.ayuda, consecuencia = MESSAGES.reintentar.consecuencia, onResultado,
}: {
  tipos: TipoReintentable[];
  sequenceId: string | null;
  contact: string | null;
  /** Qué pasa después: «salen en la próxima pasada», o, con el envío apagado, que vuelven pero no salen. */
  ayuda?: string;
  /** Lo que dice la pregunta: salen en la próxima pasada o, con el envío apagado, que no salen. */
  consecuencia?: string;
  onResultado: (r: ActividadState) => void;
}) {
  const t = MESSAGES.reintentar;

  async function reintentar(stepType: string) {
    onResultado(await reintentarPorTipo({ stepType, sequenceId, contact }));
  }

  if (tipos.length === 0) return null;
  return (
    <section aria-labelledby="reintentar-titulo" className="rounded-md border border-line bg-surface p-3 sm:p-4">
      <h2 id="reintentar-titulo" className="text-sm font-semibold">{t.titulo}</h2>
      <p className="mt-1 text-xs text-fg-2">{ayuda}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {tipos.map((tipo) => (
          <ConfirmInline
            key={tipo.stepType}
            action={() => reintentar(tipo.stepType)}
            label={tipo.label}
            variant="secondary"
            question={tipo.pregunta}
            consequence={consecuencia}
            confirmLabel={t.confirmar}
            cancelLabel={t.volver}
            openWidth="w-full sm:w-96"
          />
        ))}
      </div>
    </section>
  );
}
