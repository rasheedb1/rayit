"use client";

import { Button } from "@/components/ui/button";
import { marcarGestoHecho } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/**
 * «Hecho» en un gesto a mano de la cadencia (comentario o reacción en una
 * red, tarea a mano): la persona lo hizo por su cuenta y lo anota. Sale de
 * la cola y la cadencia sigue con el paso siguiente. No manda nada a
 * nadie, así que no pide confirmación (pulido r6).
 */
export function GestoHecho({ companyId, touchId, persona }: { companyId: string; touchId: string; persona: string }) {
  const t = FICHA.cadencia.aMano;
  const { state, pending, formRef, onSubmit } = useVentasForm(marcarGestoHecho);

  return (
    <div className="grid gap-2">
      <form ref={formRef} onSubmit={onSubmit} noValidate className="inline-flex">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="touchId" value={touchId} />
        <Button type="submit" variant="secondary" size="sm" loading={pending} aria-label={t.botonLabel(persona)}>
          {t.boton}
        </Button>
      </form>
      <Aviso message={state.message} notice={state.notice} />
    </div>
  );
}
