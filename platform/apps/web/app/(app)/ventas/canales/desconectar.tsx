"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { desconectar } from "./actions";
import { MESSAGES } from "./messages";

/**
 * Desconectar pide confirmación en el mismo sitio (no un diálogo del
 * navegador): el primer clic pregunta, el segundo desconecta.
 */
export function Desconectar({ accountId }: { accountId: string }) {
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  if (!asking) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
        {MESSAGES.actions.disconnect}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={MESSAGES.actions.disconnect} className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-fg-2">{MESSAGES.actions.disconnectConfirm}</span>
      <Button
        size="sm"
        variant="danger"
        loading={pending}
        onClick={() => {
          const form = new FormData();
          form.set("accountId", accountId);
          start(() => desconectar(form));
        }}
      >
        {MESSAGES.actions.disconnect}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
        {MESSAGES.actions.cancel}
      </Button>
    </div>
  );
}
