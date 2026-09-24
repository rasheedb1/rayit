"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { aprobarMensaje } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/**
 * «Revisar y aprobar» un mensaje retenido de la cadencia (VEN-10 r5): se
 * abre en su fila con el asunto (solo correo) y el texto a la vista y
 * editables, y «Aprobar y enviar» lo devuelve a la cola. Lo que la base
 * rechaza (huecos sin rellenar, una nota demasiado larga) vuelve en el
 * campo del texto; lo demás, como aviso.
 */
export function AprobarMensaje({
  companyId,
  touchId,
  persona,
  isEmail,
  subject,
  body,
}: {
  companyId: string;
  touchId: string;
  persona: string;
  isEmail: boolean;
  subject: string | null;
  body: string;
}) {
  const t = FICHA.cadencia;
  const [open, setOpen] = useState(false);
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(aprobarMensaje, () => setOpen(false));
  const id = `aprobar-${touchId}`;

  if (!open) {
    return (
      <div className="grid gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label={t.revisarLabel(persona)}>
          {t.revisar}
        </Button>
        <Aviso message={state.message} notice={state.notice} />
      </div>
    );
  }
  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="grid gap-3" aria-label={t.revisarLabel(persona)}>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="touchId" value={touchId} />
      {isEmail ? (
        <Field label={t.asunto} htmlFor={`${id}-subject`} error={errors.subject}>
          <Input name="subject" defaultValue={subject ?? ""} />
        </Field>
      ) : (
        <input type="hidden" name="subject" value="" />
      )}
      <Field label={t.texto} help={t.textoHelp} htmlFor={`${id}-body`} error={errors.body}>
        <Textarea name="body" rows={5} defaultValue={body} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {t.aprobar}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t.cerrar}
        </Button>
      </div>
      <Aviso message={state.message} notice={state.notice} />
    </form>
  );
}
