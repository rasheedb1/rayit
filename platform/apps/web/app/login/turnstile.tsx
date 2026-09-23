"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";
import { MESSAGES } from "@/lib/auth/messages";

/**
 * El widget de Cloudflare Turnstile (CIM-10), con render EXPLÍCITO.
 *
 * El modo implícito de Turnstile busca `.cf-turnstile` una sola vez al
 * cargar el script, y aquí el formulario cambia de estado sin recargar
 * («Revisa tu correo» con su «Reenviar», que también pide enlace y por
 * tanto también necesita token). Por eso se pinta a mano en cada montaje
 * y se reinicia cada vez que el servidor contesta: un token sirve para
 * UNA petición, y el que ya se mandó no vale para la siguiente.
 *
 * El token viaja en el campo oculto `captchaToken` del mismo formulario;
 * lo lee app/login/acciones.ts y lo verifica Supabase, no nosotros.
 */
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface OpcionesTurnstile {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  theme: "auto";
  size: "flexible";
  language: string;
}

interface ApiTurnstile {
  render(elemento: HTMLElement, opciones: OpcionesTurnstile): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: ApiTurnstile;
  }
}

export function Turnstile({
  siteKey,
  onToken,
  reinicio,
}: {
  siteKey: string;
  /** El token nuevo, o "" cuando caduca, falla o se reinicia. */
  onToken: (token: string) => void;
  /** Cualquier valor que cambie cuando el servidor contesta: reinicia el widget. */
  reinicio: unknown;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const alToken = useRef(onToken);
  alToken.current = onToken;

  const pintar = () => {
    const api = window.turnstile;
    if (!api || !caja.current || widget.current) return;
    widget.current = api.render(caja.current, {
      sitekey: siteKey,
      callback: (token) => alToken.current(token),
      "expired-callback": () => alToken.current(""),
      "error-callback": () => alToken.current(""),
      theme: "auto",
      size: "flexible",
      language: "es",
    });
  };

  // Si el script ya estaba cargado (volver a este estado del formulario),
  // `onReady` no se vuelve a disparar: se pinta al montar.
  useEffect(() => {
    pintar();
    return () => {
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
    // `pintar` lee refs; solo tiene que correr al montar y si cambia la clave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  // Cada respuesta del servidor gasta el token que se mandó.
  const primera = useRef(true);
  useEffect(() => {
    if (primera.current) {
      primera.current = false;
      return;
    }
    if (widget.current) window.turnstile?.reset(widget.current);
    alToken.current("");
  }, [reinicio]);

  return (
    <>
      <Script src={SCRIPT} strategy="afterInteractive" onReady={pintar} />
      <div ref={caja} aria-label={MESSAGES.login.captchaEtiqueta} className="min-h-[65px]" />
    </>
  );
}
