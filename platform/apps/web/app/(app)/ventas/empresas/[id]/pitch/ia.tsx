"use client";

import { useState } from "react";
import type { RegenerateHint } from "@mc/core/outreach/preflight";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import { PITCH } from "./messages";

/** Las tres pistas a la vista, como los tres botones del generador de Chief. */
export const EDITOR_HINTS = ["shorter", "more_specific", "other_angle"] as const satisfies readonly RegenerateHint[];
/**
 * Las otras tres, en «Más»: las que se usan después de leer la nota de la
 * revisión automática. «Otra señal» solo si la empresa tiene más de una.
 * Entre las dos listas están las seis pistas cerradas (REGENERATE_HINTS).
 */
export const MORE_HINTS = ["soften", "add_proof", "other_signal"] as const satisfies readonly RegenerateHint[];

export type AiStatus = "on" | "off" | "unknown";

export interface PendingDraft {
  stage: string;
  hint: RegenerateHint | null;
  /** El código del último fallo ('llm_budget', 'interrupted'…), nunca el texto del error: se traduce en messages.ts. */
  error: string | null;
}

/**
 * «Redactar con IA» dentro del editor: el paso de Chief de tono e
 * instrucciones, con la señal que usa a la vista, un botón para pedir un
 * borrador (u otra versión) y tres pistas cerradas. No llama al modelo:
 * pide y el worker redacta; mientras tanto dice en qué va. Si la IA no
 * está disponible lo dice en palabras de la creadora (el detalle técnico
 * está en los registros del worker) y no deja pedir. Si se rindió con este
 * borrador, lo dice y deja pedir otra versión.
 */
export function PanelIA({
  status,
  pending,
  failed = false,
  hasBody,
  hasContact,
  signalHeadline,
  manySignals = false,
  busy,
  onRequest,
}: {
  status: AiStatus;
  pending: PendingDraft | null;
  /** La IA no pudo con el último pedido (0063). */
  failed?: boolean;
  hasBody: boolean;
  hasContact: boolean;
  signalHeadline: string | null;
  /** La empresa tiene más de una señal viva: «Otra señal» tiene de dónde sacar. */
  manySignals?: boolean;
  /** Una petición en vuelo desde esta pantalla. */
  busy: boolean;
  onRequest: (hint: RegenerateHint | null, instructions: string) => void;
}) {
  const t = PITCH.ia;
  const [instructions, setInstructions] = useState("");
  const [more, setMore] = useState(false);
  const moreHints = MORE_HINTS.filter((h) => h !== "other_signal" || manySignals);
  const off = status !== "on";
  const disabled = off || !hasContact || pending !== null || busy;
  return (
    <section aria-labelledby="pitch-ia" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-md border border-border bg-surface-2 p-3">
      <div className="min-w-0">
        <h2 id="pitch-ia" className="text-sm font-medium text-ink">
          {t.titulo}
        </h2>
        <p className="mt-1 text-xs text-muted">{t.help}</p>
        <p className="mt-1 break-words text-xs text-ink-2">{signalHeadline ? t.senal(signalHeadline) : t.sinSenal}</p>
      </div>
      {off ? (
        <p className="text-sm text-ink-2">{status === "off" ? t.noConfigurada : t.desconocida}</p>
      ) : pending ? (
        <div aria-live="polite" className="grid gap-1 text-sm">
          <p className="text-ink">
            <span className="font-medium">{t.pendienteDe[pending.stage] ?? t.pendienteDe.requested}</span> · {t.redactando}
          </p>
          {pending.error && <p className="text-xs text-muted">{t.reintento(pending.error)}</p>}
          <p className="text-xs text-muted">{t.editarCancela}</p>
        </div>
      ) : (
        <>
          {failed && <p className="text-sm text-ink-2">{t.fallo}</p>}
          <Field label={t.instrucciones} help={t.instruccionesHelp} htmlFor="pitch-instrucciones">
            <Textarea rows={2} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="primary" disabled={disabled} loading={busy} onClick={() => onRequest(null, instructions)}>
              {hasBody ? t.volverARedactar : t.redactar}
            </Button>
            {hasBody &&
              EDITOR_HINTS.map((h) => (
                <Button key={h} type="button" size="sm" disabled={disabled} aria-label={t.pistaLabel(t.pistas[h])} onClick={() => onRequest(h, instructions)}>
                  {t.pistas[h]}
                </Button>
              ))}
            {hasBody && (
              <Button type="button" size="sm" variant="ghost" aria-expanded={more} aria-controls="pitch-mas-pistas" onClick={() => setMore(!more)}>
                {more ? t.menos : t.mas}
              </Button>
            )}
          </div>
          {hasBody && more && (
            <div id="pitch-mas-pistas" role="group" aria-label={t.masLabel} className="flex flex-wrap items-center gap-2">
              {moreHints.map((h) => (
                <Button key={h} type="button" size="sm" disabled={disabled} aria-label={t.pistaLabel(t.pistas[h])} onClick={() => onRequest(h, instructions)}>
                  {t.pistas[h]}
                </Button>
              ))}
            </div>
          )}
          {!hasContact && <p className="text-xs text-muted">{t.necesitaContacto}</p>}
        </>
      )}
    </section>
  );
}
