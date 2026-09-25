"use client";

import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { resolverIntento } from "../actions";
import { Aviso } from "../../../_lib/aviso";
import { useVentasForm } from "../../_lib/use-ventas-form";
import { FICHA } from "../messages";

/** Lo primero del mensaje, para reconocerlo en la carpeta de enviados: hasta tres líneas. */
function primerasLineas(texto: string, lineas = 3): string {
  const todas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  const corte = todas.slice(0, lineas).join("\n");
  return todas.length > lineas ? `${corte}…` : corte;
}

/**
 * Un mensaje retenido porque no se supo si un intento salió: el proveedor
 * no lo confirmó. La persona lo busca en su carpeta de enviados (o en el
 * chat de LinkedIn o Instagram) con lo que aquí se le enseña (el asunto,
 * las primeras líneas, la cuenta que lo envió y el día) y dice qué pasó.
 * «Sí, salió» lo anota como enviado y la cadencia sigue. «No salió:
 * enviarlo» manda el mensaje a la marca, así que pide confirmación en el
 * sitio (el patrón del interruptor de /ventas/politica): un clic por error
 * duplicaría justo el correo que esto existe para no duplicar.
 */
export function ResolverIntento({
  companyId,
  touchId,
  persona,
  canal,
  subject,
  body,
  cuenta,
  dia,
}: {
  companyId: string;
  touchId: string;
  persona: string;
  /** El nombre del canal, ya en palabras («Correo»). */
  canal: string;
  subject: string | null;
  body: string;
  /** La cuenta que lo envió (su nombre o su dirección), si se sabe. */
  cuenta: string | null;
  /** El día del intento, ya formateado, si se sabe. */
  dia: string | null;
}) {
  const t = FICHA.cadencia.intento;
  const { state, pending, formRef, onSubmit, resubmit } = useVentasForm(resolverIntento);

  return (
    <div className="grid gap-2">
      <p className="text-xs text-ink-2">{t.pregunta({ canal, asunto: subject, dia, cuenta })}</p>
      <blockquote className="whitespace-pre-line border-l-2 border-line pl-3 text-xs text-ink-2">
        {subject && <span className="block font-medium text-ink">{subject}</span>}
        {primerasLineas(body)}
      </blockquote>
      <div className="flex flex-wrap items-start gap-2">
        <form ref={formRef} onSubmit={onSubmit} noValidate className="inline-flex">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="touchId" value={touchId} />
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
        </form>
        <ConfirmInline
          action={async () => resubmit({ outcome: "resend" })}
          label={t.noSalio}
          variant="ghost"
          question={t.confirmarReenvio}
          consequence={t.consecuenciaReenvio(persona)}
          confirmLabel={t.siReenviar}
          cancelLabel={t.cancelar}
          openWidth="w-full sm:w-80"
        />
      </div>
      <Aviso message={state.message} notice={state.notice} />
    </div>
  );
}
