"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Aviso } from "../../_lib/aviso";

/** Cada cuánto se vuelve a mirar una conexión que no terminó, y hasta cuándo. */
export const REFRESH_EVERY_MS = 3_000;
export const REFRESH_FOR_MS = 60_000;

/**
 * El aviso de arriba de /ventas/canales (el cálculo, en _lib/banner.ts).
 *
 *   · Si la conexión todavía no terminó (Unipile devolvió a la persona
 *     antes de mandar su aviso), refresca la pantalla cada tres segundos
 *     durante un minuto: en cuanto la fila pasa a «Conectado», el servidor
 *     devuelve el aviso de éxito.
 *   · Si ya dijo lo que tenía que decir, quita ?conectado= y ?error= de la
 *     URL con history.replaceState (Next lo integra con su router sin
 *     volver a pedir la página), para que no reaparezca al recargar.
 */
export function AvisoConexion({ message, notice, refresh }: { message: string | null; notice: string | null; refresh: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (refresh) {
      const started = Date.now();
      const id = window.setInterval(() => {
        if (Date.now() - started > REFRESH_FOR_MS) window.clearInterval(id);
        else router.refresh();
      }, REFRESH_EVERY_MS);
      return () => window.clearInterval(id);
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has("conectado") || url.searchParams.has("error")) {
      url.searchParams.delete("conectado");
      url.searchParams.delete("error");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return undefined;
  }, [refresh, router]);
  return <Aviso message={message} notice={notice} />;
}
