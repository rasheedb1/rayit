"use client";

import { Button } from "@/components/ui/button";
import { resolverIntento } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/**
 * Un mensaje retenido porque no se supo si un intento salió (VEN-10 r3):
 * la persona lo mira en su carpeta de enviados, o en el chat de LinkedIn o
 * Instagram, y lo dice con un botón. «Sí, salió» lo anota como enviado y
 * la cadencia sigue; «No salió: enviarlo» lo devuelve a la cola. Antes solo
 * había «Aprobar» (volver a enviar), y un mensaje que sí había salido
 * quedaba sin salida.
 */
export function ResolverIntento({ companyId, touchId, persona }: { companyId: string; touchId: string; persona: string }) {
  const t = FICHA.cadencia.intento;
  const { state, pending, formRef, onSubmit, resubmit } = useVentasForm(resolverIntento);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="grid gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="touchId" value={touchId} />
      <p className="text-xs text-ink-2">{t.pregunta}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => resubmit({ outcome: "was_sent" })}
          aria-label={t.salioLabel(persona)}
        >
          {t.salio}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => resubmit({ outcome: "resend" })}
          aria-label={t.noSalioLabel(persona)}
        >
          {t.noSalio}
        </Button>
      </div>
      <Aviso message={state.message} notice={state.notice} />
    </form>
  );
}
