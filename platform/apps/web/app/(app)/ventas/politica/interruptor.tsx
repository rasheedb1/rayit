"use client";

import { useEffect, useRef, useState } from "react";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { apagarEnvio, encenderEnvio } from "./actions";
import { MESSAGES } from "./messages";

/**
 * El interruptor del envío automático, arriba de la política: el estado
 * con su pill, una línea que dice qué implica, y el botón.
 *
 * Encender y apagar piden confirmación en el sitio, con el patrón del
 * producto (ConfirmInline del kit, nacida en Cotizar: el primer botón enseña qué va a
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
 * canceló nada, de una que se apagó. `aprobadosHoy` llega formateado y
 * crudo (el crudo elige el plural).
 *
 * Los dos ConfirmInline llevan una `key` por estado (r4): ocupan el
 * mismo sitio, y sin ella React reutilizaba el de encender para apagar,
 * con la confirmación ya abierta y el foco en ella justo después de
 * encender. Un segundo clic distraído deshacía lo que se acababa de hacer.
 *
 * Después de encender o apagar (r5), el ConfirmInline desaparece con el
 * botón que tenía el foco. Para que quien navega con teclado o con lector
 * de pantalla no se quede en <body>, el foco va al título del interruptor
 * (tabIndex=-1) y una región role=status dice «Envío encendido» o «Envío
 * apagado». La región existe siempre, vacía, para que el lector anuncie
 * el cambio.
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
  /** Los mensajes aprobados que salen hoy al encender: `n` formateado, `cuantos` sin formatear. */
  aprobadosHoy: { n: string; cuantos: number };
}) {
  const t = MESSAGES.interruptor;
  const [error, setError] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState<string | null>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const llevarElFoco = useRef(false);

  // Cuando el cambio ya se pintó (el anuncio, o la página con el nuevo estado), el foco va al título.
  useEffect(() => {
    if (!llevarElFoco.current) return;
    llevarElFoco.current = false;
    tituloRef.current?.focus();
  }, [anuncio, enabled]);

  async function encender() {
    setError(null);
    setAnuncio(null);
    const r = await encenderEnvio();
    if (!r.ok) return setError(r.message);
    llevarElFoco.current = true;
    setAnuncio(t.anuncioEncendido);
  }

  async function apagar() {
    setError(null);
    setAnuncio(null);
    const r = await apagarEnvio();
    if (!r.ok) return setError(r.message);
    llevarElFoco.current = true;
    setAnuncio(t.anuncioApagado);
  }

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
  // Y adónde ir a arreglarlo: la dirección está al final de una página larga (en el móvil, muy abajo).
  const arreglo =
    falta === t.sinDireccion
      ? { href: "#postalAddress", label: t.irADireccion, foco: "postalAddress" }
      : falta === t.sinCanal
        ? { href: OUTREACH_URLS.channels, label: t.irACanales, foco: null }
        : null;
  // Si falta algo, la línea de abajo dice el paso concreto: la de arriba no lo repite (r4).
  const ayuda = enabled
    ? t.onHelp
    : (motivo ?? (nuncaEncendido ? (falta ? t.offHelpNuncaCorto : t.offHelpListo) : t.offHelp));

  return (
    <section aria-labelledby="interruptor" className="mb-10 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 id="interruptor" ref={tituloRef} tabIndex={-1} className="text-sm font-semibold outline-none!">
              {t.title}
            </h2>
            <Pill kind={enabled ? "good" : "neutral"}>{enabled ? t.on : t.off}</Pill>
          </div>
          <p className="mt-1 text-sm text-fg-2">{ayuda}</p>
          {falta && (
            <p id="interruptor-falta" className="mt-1 text-xs text-muted">
              {falta}
              {arreglo && (
                <>
                  {" "}
                  <a
                    href={arreglo.href}
                    className="font-medium text-accent underline-offset-2 hover:underline"
                    onClick={() => {
                      // El ancla lleva la página al campo; el foco deja a quien usa teclado o lector escribiendo ahí.
                      if (arreglo.foco) document.getElementById(arreglo.foco)?.focus();
                    }}
                  >
                    {arreglo.label}
                  </a>
                </>
              )}
            </p>
          )}
        </div>
        {!puedeCambiar ? (
          <Button variant={enabled ? "danger" : "primary"} disabled>
            {enabled ? t.apagar : t.encender}
          </Button>
        ) : enabled ? (
          <ConfirmInline
            key="apagar"
            action={apagar}
            label={t.apagar}
            variant="danger"
            question={t.confirmarApagar}
            consequence={t.consecuenciaApagar}
            confirmLabel={t.siApagar}
            cancelLabel={t.cancelar}
            openWidth="w-full sm:w-80"
          />
        ) : falta ? (
          <Button variant="primary" disabled>
            {t.encender}
          </Button>
        ) : (
          <ConfirmInline
            key="encender"
            action={encender}
            label={t.encender}
            variant="primary"
            question={t.confirmarEncender}
            consequence={t.consecuenciaEncender(aprobadosHoy.n, aprobadosHoy.cuantos)}
            confirmLabel={t.siEncender}
            cancelLabel={t.cancelar}
            openWidth="w-full sm:w-80"
          />
        )}
      </div>
      <p role="status" className="sr-only">
        {anuncio}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
