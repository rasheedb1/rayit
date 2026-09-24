"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { ConfirmarAccion } from "../../cotizar/_ui/confirmar-accion";
import { apagarEnvio, encenderEnvio } from "./actions";
import { MESSAGES } from "./messages";

/**
 * El interruptor del envío automático, arriba de la política: el estado
 * con su pill, una línea que dice qué implica, y el botón.
 *
 * Encender y apagar piden confirmación en el sitio, con el patrón del
 * producto (ConfirmarAccion de Cotizar: el primer botón enseña qué va a
 * pasar, el segundo es el que actúa). Apagar, porque cancela la cola;
 * encender, porque es lo que empieza a escribir a marcas en nombre del
 * creador, y dice cuántos mensajes aprobados salen hoy.
 *
 * Encender se ofrece deshabilitado, con su motivo en una línea, mientras
 * falte algo: el rol (owner o admin, 0038 §7), una cuenta de envío
 * conectada o la dirección postal. La acción y la base lo vuelven a mirar.
 *
 * `motivo` llega ya armado por la página («Apagado el 23 de septiembre: …»);
 * `nuncaEncendido` distingue una política recién creada, en la que no se
 * canceló nada, de una que se apagó. `aprobadosHoy` llega formateado.
 */
export function Interruptor({
  enabled,
  hasAddress,
  motivo,
  nuncaEncendido,
  puedeCambiar,
  cuentasConectadas,
  aprobadosHoy,
}: {
  enabled: boolean;
  hasAddress: boolean;
  motivo: string | null;
  nuncaEncendido: boolean;
  /** owner o admin del workspace (0038 §7). */
  puedeCambiar: boolean;
  /** Cuentas de envío conectadas: sin ninguna, encender no enviaría nada. */
  cuentasConectadas: number;
  /** Los mensajes aprobados que salen hoy al encender, ya formateados. */
  aprobadosHoy: { n: string; hay: boolean };
}) {
  const t = MESSAGES.interruptor;
  const [error, setError] = useState<string | null>(null);

  async function encender() {
    setError(null);
    const r = await encenderEnvio();
    if (!r.ok) setError(r.message);
  }

  async function apagar() {
    setError(null);
    const r = await apagarEnvio();
    if (!r.ok) setError(r.message);
  }

  const ayuda = enabled ? t.onHelp : (motivo ?? (nuncaEncendido ? t.offHelpNunca : t.offHelp));
  // Lo primero que falta, en una línea. El rol va antes: sin él, lo demás no importa.
  const falta = !puedeCambiar
    ? t.sinPermiso
    : enabled
      ? null
      : !hasAddress
        ? t.sinDireccion
        : cuentasConectadas === 0
          ? t.sinCanal
          : null;

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
          {falta && (
            <p id="interruptor-falta" className="mt-1 text-xs text-muted">
              {falta}
            </p>
          )}
        </div>
        {!puedeCambiar ? (
          <Button variant={enabled ? "danger" : "primary"} disabled>
            {enabled ? t.apagar : t.encender}
          </Button>
        ) : enabled ? (
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
        ) : falta ? (
          <Button variant="primary" disabled>
            {t.encender}
          </Button>
        ) : (
          <ConfirmarAccion
            action={encender}
            label={t.encender}
            variant="primary"
            pregunta={t.confirmarEncender}
            consecuencia={t.consecuenciaEncender(aprobadosHoy.n, aprobadosHoy.hay)}
            confirmar={t.siEncender}
            cancelar={t.cancelar}
            anchoAbierta="w-full sm:w-80"
          />
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
