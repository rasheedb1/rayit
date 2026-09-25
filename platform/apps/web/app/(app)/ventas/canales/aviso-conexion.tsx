"use client";

import { useEffect, useState } from "react";
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
 *     devuelve el aviso de éxito. Si el minuto pasa sin confirmación, el
 *     aviso cambia a `slowNotice` («LinkedIn tarda en confirmar. Si en
 *     unos minutos…»): la persona ya terminó su parte y no se le promete
 *     para siempre que «estamos terminando».
 *   · Si ya dijo lo que tenía que decir, quita ?conectado=, ?error= y ?canal= de la
 *     URL con history.replaceState (Next lo integra con su router sin
 *     volver a pedir la página), para que no reaparezca al recargar.
 */
export function AvisoConexion({
  message, notice, warning = null, info = null, refresh, slowNotice = null,
}: { message: string | null; notice: string | null; warning?: string | null; info?: string | null; refresh: boolean; slowNotice?: string | null }) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (refresh) {
      const started = Date.now();
      const id = window.setInterval(() => {
        if (Date.now() - started > REFRESH_FOR_MS) {
          window.clearInterval(id);
          setSlow(true);
        } else router.refresh();
      }, REFRESH_EVERY_MS);
      return () => window.clearInterval(id);
    }
    const url = new URL(window.location.href);
    if (["conectado", "error", "canal"].some((k) => url.searchParams.has(k))) {
      url.searchParams.delete("conectado");
      url.searchParams.delete("error");
      url.searchParams.delete("canal");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return undefined;
  }, [refresh, router]);
  return <Aviso message={message} warning={warning} info={info} notice={refresh && slow && slowNotice ? slowNotice : notice} />;
}
