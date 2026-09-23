"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { marcarHecha } from "../empresas/actions";
import { FICHA } from "../empresas/messages";
import { Aviso } from "../../_lib/aviso";
import { useVentasForm } from "../_lib/use-ventas-form";
import type { SeguimientoContexto, SiguienteAccionData } from "./datos";
import { EditorSiguienteAccion } from "./siguiente-accion";

/**
 * «¿Era “Llamar a Laura Quintero”? Marcarla hecha» (VEN-4, VEN-5).
 *
 * Aparece en el registro rápido después de registrar una llamada, un
 * correo o una reunión en un negocio cuya siguiente acción está vencida
 * o vence hoy (logActivity lo decide en la base): quien acaba de llamar
 * probablemente acaba de hacer justo eso. Como en Attio y en Close, se
 * propone cerrar la tarea; nada se marca solo.
 *
 *   · «Marcarla hecha» llama a la misma acción que «Hecha» de la línea
 *     (la deja como nota en la historia) y abre, aquí mismo, el editor de
 *     la siguiente, vacío y para mañana.
 *   · «No» la deja como está.
 *
 * `onClose` avisa cuando termina, con lo que hay que decir: «Guardada
 * para el…» si se puso la siguiente, o que quedó sin ella.
 */
export function CerrarPendiente({
  action,
  dealName,
  data,
  ctx,
  onClose,
}: {
  /** El texto de la acción pendiente, como lo leyó el servidor al registrar. */
  action: string;
  /** El negocio, si la empresa tiene más de uno abierto; si no, no hace falta decirlo. */
  dealName: string | null;
  data: SiguienteAccionData;
  ctx: SeguimientoContexto;
  onClose: (notice?: string) => void;
}) {
  const t = FICHA.actividad.pendiente;
  const [editing, setEditing] = useState(false);
  const hecha = useVentasForm(marcarHecha, () => setEditing(true));

  if (editing) {
    return (
      <EditorSiguienteAccion
        data={data}
        ctx={ctx}
        compact={false}
        blank
        notice={FICHA.siguiente.doneNotice}
        onDone={(msg) => onClose(msg)}
        onCancel={() => onClose(t.leftWithout)}
      />
    );
  }

  return (
    <div role="group" aria-label={t.label(action)} className="rounded-md border border-border bg-surface-2 p-3">
      <p className="text-sm text-ink">
        {t.question(action)}
        {dealName && <span className="text-muted"> {t.deal(dealName)}</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <form ref={hecha.formRef} onSubmit={hecha.onSubmit} noValidate>
          <input type="hidden" name="dealId" value={data.dealId} />
          <Button type="submit" size="sm" variant="primary" loading={hecha.pending} aria-label={t.markDoneLabel(action)}>
            {t.markDone}
          </Button>
        </form>
        <Button size="sm" variant="ghost" onClick={() => onClose()} disabled={hecha.pending} aria-label={t.dismissLabel(action)}>
          {t.dismiss}
        </Button>
      </div>
      <Aviso message={hecha.state.message} size="xs" className="mt-2" />
    </div>
  );
}
