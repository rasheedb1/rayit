"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { ConfirmarAccion } from "../../cotizar/_ui/confirmar-accion";
import { apagarEnvio, encenderEnvio } from "./actions";
import { MESSAGES } from "./messages";

/**
 * El interruptor del envío automático, arriba de la política: el estado
 * con su pill, una línea que dice qué implica, y el botón.
 *
 * Apagar pide confirmación en el sitio, con el patrón del producto
 * (ConfirmarAccion de Cotizar: el primer botón enseña qué va a pasar, el
 * segundo, «Sí, apagar», es el que apaga), porque cancela la cola.
 * Encender no la pide, pero sin dirección postal la base lo rechaza y se
 * dice por qué.
 *
 * `motivo` llega ya armado por la página («Apagado el 23 de septiembre: …»);
 * `nuncaEncendido` distingue una política recién creada, en la que no se
 * canceló nada, de una que se apagó.
 */
export function Interruptor({
  enabled,
  hasAddress,
  motivo,
  nuncaEncendido,
}: {
  enabled: boolean;
  hasAddress: boolean;
  motivo: string | null;
  nuncaEncendido: boolean;
}) {
  const t = MESSAGES.interruptor;
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function encender() {
    setError(null);
    startTransition(async () => {
      const r = await encenderEnvio();
      if (!r.ok) setError(r.message);
    });
  }

  async function apagar() {
    setError(null);
    const r = await apagarEnvio();
    if (!r.ok) setError(r.message);
  }

  const ayuda = enabled ? t.onHelp : (motivo ?? (nuncaEncendido ? t.offHelpNunca : t.offHelp));

  return (
    <section aria-labelledby="interruptor" className="mb-10 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 id="interruptor" className="text-sm font-semibold">
              {t.title}
            </h2>
            <Pill kind={enabled ? "good" : "neutral"}>{enabled ? t.on : t.off}</Pill>
          </div>
          <p className="mt-1 text-sm text-fg-2">{ayuda}</p>
          {!enabled && !hasAddress && <p className="mt-1 text-xs text-muted">{t.sinDireccion}</p>}
        </div>
        {enabled ? (
          <ConfirmarAccion
            action={apagar}
            label={t.apagar}
            variant="danger"
            pregunta={t.confirmarApagar}
            consecuencia={t.consecuenciaApagar}
            confirmar={t.siApagar}
            cancelar={t.cancelar}
            anchoAbierta="w-full sm:w-80"
          />
        ) : (
          <Button variant="primary" loading={pending} onClick={encender} disabled={!hasAddress}>
            {t.encender}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
