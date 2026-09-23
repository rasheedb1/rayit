"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { apagarEnvio, encenderEnvio } from "./actions";
import { MESSAGES } from "./messages";

/**
 * El interruptor del envío automático, arriba de la política: el estado
 * con su pill, una línea que dice qué implica, y el botón. Apagar pide
 * confirmación (cancela la cola); encender no, pero sin dirección postal
 * la base lo rechaza y se dice por qué.
 *
 * `motivo` llega ya armado por la página («Apagado el 23 de septiembre: …»).
 */
export function Interruptor({ enabled, hasAddress, motivo }: { enabled: boolean; hasAddress: boolean; motivo: string | null }) {
  const t = MESSAGES.interruptor;
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cambiar() {
    if (enabled && !window.confirm(t.confirmarApagar)) return;
    setError(null);
    startTransition(async () => {
      const r = enabled ? await apagarEnvio() : await encenderEnvio();
      if (!r.ok) setError(r.message);
    });
  }

  return (
    <section aria-labelledby="interruptor" className="mb-10 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 id="interruptor" className="text-sm font-semibold">
              {t.title}
            </h2>
            <Pill kind={enabled ? "good" : "neutral"}>{enabled ? t.on : t.off}</Pill>
          </div>
          <p className="mt-1 text-sm text-fg-2">{enabled ? t.onHelp : (motivo ?? t.offHelp)}</p>
          {!enabled && !hasAddress && <p className="mt-1 text-xs text-muted">{t.sinDireccion}</p>}
        </div>
        <Button variant={enabled ? "danger" : "primary"} loading={pending} onClick={cambiar} disabled={!enabled && !hasAddress}>
          {enabled ? t.apagar : t.encender}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
