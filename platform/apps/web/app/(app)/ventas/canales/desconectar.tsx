"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { desconectar } from "./actions";
import { useAvisoDeFila } from "./fila-canal";
import { MESSAGES } from "./messages";

/**
 * Desconectar pide confirmación en el mismo sitio (no un diálogo del
 * navegador): el primer clic pregunta, el segundo desconecta.
 *
 * El foco acompaña: al preguntar va al botón de confirmar (y la pregunta
 * se anuncia, aria-live), y al cancelar vuelve a «Desconectar». Sin esto,
 * el botón pulsado desaparecía y el foco caía en el cuerpo de la página:
 * quien usa teclado o lector de pantalla perdía el sitio y no oía la
 * pregunta. `account`, el nombre de la cuenta, va en los nombres
 * accesibles: con varias cuentas del mismo canal, se sabe cuál.
 *
 * Al terminar, este control desaparece con su cuenta: la confirmación
 * («Desconectaste …») la anuncia la fila del canal (FilaCanal), que
 * también se queda con el foco.
 */
export function Desconectar({ accountId, account }: { accountId: string; account: string }) {
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const confirmRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLSpanElement>(null);
  const wasAsking = useRef(false);
  const announce = useAvisoDeFila();

  useEffect(() => {
    if (asking) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (wasAsking.current) openerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <span ref={openerRef}>
        <Button size="sm" variant="ghost" onClick={() => setAsking(true)} aria-label={MESSAGES.actions.disconnectAccount(account)}>
          {MESSAGES.actions.disconnect}
        </Button>
      </span>
    );
  }
  return (
    <div role="group" aria-label={MESSAGES.actions.disconnectAccount(account)} className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-fg-2" aria-live="polite">{MESSAGES.actions.disconnectConfirm}</span>
      <div ref={confirmRef} className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="danger"
          loading={pending}
          onClick={() => {
            const form = new FormData();
            form.set("accountId", accountId);
            start(async () => announce(await desconectar(form)));
          }}
        >
          {MESSAGES.actions.disconnect}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
          {MESSAGES.actions.cancel}
        </Button>
      </div>
    </div>
  );
}
