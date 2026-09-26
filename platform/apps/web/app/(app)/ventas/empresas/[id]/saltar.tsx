"use client";

import { ConfirmInline } from "@/components/ui/confirm-inline";
import { saltarMensaje } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/**
 * «Saltar este paso» de un mensaje retenido: no sale y la cadencia sigue
 * con el siguiente. Es la salida de una respuesta en el hilo a un correo
 * que no salió, que no se puede aprobar (no hay hilo), y de cualquier
 * retenido que la persona prefiera no mandar. Pide confirmación en el
 * sitio (ConfirmInline): no se deshace.
 */
export function SaltarMensaje({ companyId, touchId }: { companyId: string; touchId: string }) {
  const t = FICHA.cadencia.saltar;
  const { state, formRef, resubmit } = useVentasForm(saltarMensaje);

  return (
    <div className="grid gap-2">
      <form ref={formRef} noValidate className="hidden" aria-hidden>
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="touchId" value={touchId} />
      </form>
      <ConfirmInline
        action={async () => resubmit({})}
        label={t.label}
        variant="ghost"
        question={t.pregunta}
        consequence={t.consecuencia}
        confirmLabel={t.si}
        cancelLabel={t.cancelar}
        openWidth="w-full sm:w-80"
      />
      <Aviso message={state.message} notice={state.notice} />
    </div>
  );
}
