"use client";

import { Button } from "@/components/ui/button";
import { reanudarCadencia } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/**
 * Una cadencia en pausa porque otra persona de la marca respondió
 * (0059): lo dice, y ofrece «Reanudar la cadencia». Reanudar no manda
 * nada en el acto: lo vencido sale en la próxima pasada, dentro del
 * horario y de los topes, así que no pide confirmación.
 */
export function ReanudarCadencia({ companyId, enrollmentId, persona }: { companyId: string; enrollmentId: string; persona: string }) {
  const t = FICHA.cadencia.pausa;
  const { state, pending, formRef, onSubmit } = useVentasForm(reanudarCadencia);

  return (
    <div className="grid gap-2">
      <p className="text-xs text-ink-2">{t.aviso(persona)}</p>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="inline-flex">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="enrollmentId" value={enrollmentId} />
        <Button type="submit" variant="secondary" size="sm" disabled={pending} aria-label={t.reanudarDe(persona)}>
          {t.reanudar}
        </Button>
      </form>
      <Aviso message={state.message} notice={state.notice} />
    </div>
  );
}
