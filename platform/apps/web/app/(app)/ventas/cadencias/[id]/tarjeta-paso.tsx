"use client";

import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { Pill } from "@/components/ui/pill";
import { MESSAGES } from "../messages";

/**
 * Un paso de la cadencia tal como lo pinta la línea de tiempo: todo ya
 * formateado en el servidor (día, hora, etiquetas en el idioma del
 * espacio); aquí no se formatea ni se cuenta nada.
 */
export interface PasoVista {
  id: string;
  /** «1», «2»…, en el idioma del espacio. */
  numero: string;
  diaLabel: string;
  horaLabel: string;
  tipoLabel: string;
  anguloLabel: string | null;
  guia: string | null;
  modoLabel: string;
  activoLabel: string | null;
  /** Lo que la política no dejará cumplir en este paso. */
  aviso: string | null;
  // Los valores crudos, para el editor.
  dayOffset: number;
  stepType: string;
  scheduledTime: string;
  angleKey: string | null;
  generateWithAi: boolean;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  requiresAsset: "media_kit" | "quote" | null;
}

export function TarjetaPaso({
  paso,
  primero,
  ultimo,
  mover,
  editar,
  quitar,
  arrastrable,
  editable,
  onDragStart,
  onDragEnd,
}: {
  paso: PasoVista;
  primero: boolean;
  ultimo: boolean;
  mover: (direccion: -1 | 1) => void;
  editar: () => void;
  quitar: () => Promise<void>;
  /** La forma se puede cambiar: arrastrar, subir, bajar y quitar. */
  arrastrable: boolean;
  /** El texto se puede cambiar. */
  editable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const t = MESSAGES.paso;
  return (
    <article
      aria-labelledby={`paso-${paso.id}`}
      draggable={arrastrable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", paso.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="flex min-w-0 gap-2 rounded-md border border-line bg-surface p-3 sm:p-4"
    >
      {arrastrable && (
        <span
          aria-hidden="true"
          title={t.arrastrar(paso.numero)}
          className="mt-0.5 hidden shrink-0 cursor-grab text-fg-3 active:cursor-grabbing sm:block"
        >
          <GripVertical size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 id={`paso-${paso.id}`} className="text-sm font-semibold">
            {t.titulo(paso.numero)}
          </h3>
          <span className="text-sm tabular-nums text-fg-2">
            {paso.diaLabel} · {paso.horaLabel}
          </span>
          <Pill kind="neutral">{paso.tipoLabel}</Pill>
        </header>

        <dl className="mt-3 grid gap-2 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-fg-3">{t.angulo}</dt>
            <dd className="font-medium">{paso.anguloLabel ?? t.sinAngulo}</dd>
          </div>
          <div>
            <dt className="sr-only">{t.guia}</dt>
            <dd className="whitespace-pre-line break-words text-fg-2">{paso.guia ?? t.sinGuia}</dd>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3">
            <dt className="sr-only">{t.campos.modo}</dt>
            <dd>{paso.modoLabel}</dd>
            {paso.activoLabel && <dd>{paso.activoLabel}</dd>}
          </div>
        </dl>
        {paso.aviso && <p className="mt-2 text-xs text-warn">{paso.aviso}</p>}

        {(editable || arrastrable) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {editable && (
              <Button size="sm" variant="secondary" onClick={editar}>
                {t.editar}
              </Button>
            )}
            {arrastrable && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={primero}
                  onClick={() => mover(-1)}
                  icon={<ArrowUp size={14} aria-hidden="true" />}
                >
                  <span className="sr-only">{t.subir(paso.numero)}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={ultimo}
                  onClick={() => mover(1)}
                  icon={<ArrowDown size={14} aria-hidden="true" />}
                >
                  <span className="sr-only">{t.bajar(paso.numero)}</span>
                </Button>
                <ConfirmInline
                  action={quitar}
                  label={t.quitar}
                  variant="ghost"
                  question={t.quitarPregunta}
                  consequence={t.quitarConsecuencia}
                  confirmLabel={t.quitarConfirmar}
                  cancelLabel={MESSAGES.detalle.cancelar}
                  openWidth="w-full sm:w-80"
                />
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
