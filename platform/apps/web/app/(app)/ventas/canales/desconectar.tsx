"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { desconectar } from "./actions";
import { useAvisoDeFila } from "./fila-canal";
import { MESSAGES } from "./messages";

/**
 * Desconectar pide confirmación en el mismo sitio (no un diálogo del
 * navegador): el primer clic pregunta, el segundo desconecta.
 *
 * El foco acompaña: al preguntar va al botón de confirmar, y al cancelar
 * vuelve a «Desconectar». La pregunta se anuncia por una región aria-live
 * que está montada SIEMPRE, vacía mientras no se pregunta: los lectores de
 * pantalla no anuncian de forma fiable una región que nace con el texto
 * dentro, así que el texto se escribe en una que ya existía. Sin esto,
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
  const questionId = useId();
  const announce = useAvisoDeFila();

  useEffect(() => {
    if (asking) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (wasAsking.current) openerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    wasAsking.current = asking;
  }, [asking]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Montada siempre, en el mismo sitio: vacía hasta que se pregunta, así el lector de pantalla oye la pregunta. */}
      <span id={questionId} className="text-xs text-fg-2 empty:hidden" aria-live="polite">
        {asking ? MESSAGES.actions.disconnectConfirm : ""}
      </span>
      {asking ? (
        <div
          ref={confirmRef}
          role="group"
          aria-label={MESSAGES.actions.disconnectAccount(account)}
          aria-describedby={questionId}
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            size="sm"
            variant="danger"
            loading={pending}
            onClick={(e) => {
              const form = new FormData();
              form.set("accountId", accountId);
              // detail 0: lo pulsó el teclado (Enter o espacio). Con el ratón, el título de la fila recibe el foco sin anillo.
              const pointer = e.detail > 0;
              start(async () => announce({ ...(await desconectar(form)), pointer }));
            }}
          >
            {MESSAGES.actions.disconnect}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
            {MESSAGES.actions.cancel}
          </Button>
        </div>
      ) : (
        /*
         * -ml-2.5 en el envoltorio, no en el botón: el texto del botón fantasma
         * queda alineado con el de la fila (su padding es px-2.5). En el botón,
         * el margen negativo le quitaba 10 px al ancho del envoltorio y el
         * max-w-full del kit partía «Desconectar» en dos líneas.
         */
        <span ref={openerRef} className="-ml-2.5 inline-flex shrink-0 whitespace-nowrap" data-desconectar>
          <Button size="sm" variant="ghost" onClick={() => setAsking(true)} aria-label={MESSAGES.actions.disconnectAccount(account)}>
            {MESSAGES.actions.disconnect}
          </Button>
        </span>
      )}
    </div>
  );
}
