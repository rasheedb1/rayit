"use client";

import { useState, useTransition } from "react";
import { Aviso } from "../../_lib/aviso";
import { Button } from "@/components/ui/button";
import { reactivarAvisos, type AvisosState } from "./actions";
import { MESSAGES } from "./messages";

/**
 * «Volver a intentar» de una cuenta conectada que se quedó sin avisos de
 * Unipile: los vuelve a dar de alta sin pasar otra vez por la conexión.
 * El resultado sale al lado, con el recuadro de siempre.
 */
export function ReintentarAvisos({ accountId, disabled, ariaLabel }: { accountId: string; disabled: boolean; ariaLabel?: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<AvisosState>({});
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => {
          const form = new FormData();
          form.set("accountId", accountId);
          start(async () => setState(await reactivarAvisos(form)));
        }}
      >
        {MESSAGES.actions.retry}
      </Button>
      <Aviso message={state.message} notice={state.notice} size="xs" />
    </div>
  );
}
