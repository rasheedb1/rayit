"use client";

import { useState, useTransition } from "react";
import type { SequenceStatus } from "@mc/db/queries/cadencias";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { Field, Input } from "@/components/ui/field";
import { Aviso } from "../../../_lib/aviso";
import { activarCadencia, cambiarEstado, duplicarCadencia, renombrarCadencia, type CadenciaState } from "../actions";
import { MESSAGES } from "../messages";

/**
 * Las acciones de la cadencia: activar (el segundo clic), pausar,
 * duplicar, archivar y cambiar el nombre. Activar no pide confirmación:
 * se deshace con Pausar, y lo que sale queda retenido para revisión si la
 * política lo pide (el valor por defecto). Archivar sí la pide: no se
 * deshace.
 */
export function Controles({
  sequenceId,
  status,
  nombre,
  activarLabel,
  puedeActivar,
}: {
  sequenceId: string;
  status: SequenceStatus;
  nombre: string;
  /** «Activar» o «Activar y escribir a Camila Rojas». */
  activarLabel: string;
  puedeActivar: boolean;
}) {
  const t = MESSAGES.estado;
  const [state, setState] = useState<CadenciaState>({});
  const [renombrando, setRenombrando] = useState(false);
  const [pending, start] = useTransition();
  const archivada = status === "archived";

  function correr(fn: () => Promise<CadenciaState>, despues?: () => void) {
    setState({});
    start(async () => {
      const r = await fn();
      setState(r ?? {});
      if (!r?.error) despues?.();
    });
  }

  return (
    <div className="mb-6 grid gap-3">
      {renombrando ? (
        <form
          action={(fd) => correr(() => renombrarCadencia(sequenceId, String(fd.get("nombre") ?? "")), () => setRenombrando(false))}
          className="flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end"
        >
          <Field label={MESSAGES.detalle.nombreLabel} className="min-w-0 flex-1">
            <Input name="nombre" defaultValue={nombre} maxLength={120} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={pending}>
              {MESSAGES.detalle.guardar}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenombrando(false)}>
              {MESSAGES.detalle.cancelar}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start gap-2">
          {(status === "draft" || status === "paused") && (
            <Button
              variant="primary"
              loading={pending}
              disabled={!puedeActivar}
              onClick={() => correr(() => activarCadencia(sequenceId))}
            >
              {pending ? t.activando : status === "paused" ? t.reanudar : activarLabel}
            </Button>
          )}
          {status === "active" && (
            <Button variant="secondary" loading={pending} onClick={() => correr(() => cambiarEstado(sequenceId, "paused"))}>
              {t.pausar}
            </Button>
          )}
          {!archivada && (
            <Button variant="ghost" onClick={() => setRenombrando(true)}>
              {MESSAGES.detalle.renombrar}
            </Button>
          )}
          <Button variant="ghost" onClick={() => correr(() => duplicarCadencia(sequenceId))}>
            {t.duplicar}
          </Button>
          {!archivada && (
            <ConfirmInline
              action={async () => correr(() => cambiarEstado(sequenceId, "archived"))}
              label={t.archivar}
              variant="ghost"
              question={t.archivarPregunta}
              consequence={t.archivarConsecuencia}
              confirmLabel={t.archivarConfirmar}
              cancelLabel={MESSAGES.detalle.cancelar}
              openWidth="w-full sm:w-80"
            />
          )}
        </div>
      )}
      {!puedeActivar && !archivada && status !== "active" && <p className="text-xs text-fg-3">{t.sinPasos}</p>}
      <Aviso message={state.error} notice={state.ok} />
    </div>
  );
}
