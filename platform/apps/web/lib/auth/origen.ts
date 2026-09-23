import "server-only";
import { headers } from "next/headers";
import type { Env } from "./config";

/**
 * El origen público de esta aplicación (`https://on-cue-web.vercel.app`,
 * `http://localhost:3100`), que es a donde Supabase devuelve el enlace
 * mágico.
 *
 * El orden:
 *
 *   1. APP_URL, si está fijada. Es la que ya usa el OAuth de Conexiones
 *      (CON-3) y la única que un correo puede citar sin equivocarse
 *      detrás de un proxy. En Vercel está fijada en production.
 *   2. En PRODUCCIÓN (NODE_ENV=production y no una vista previa de
 *      Vercel): VERCEL_PROJECT_PRODUCTION_URL, que pone Vercel. Y si
 *      tampoco está, se NIEGA (OrigenNoConfiguradoError). Nunca lee las
 *      cabeceras de la petición, porque `host` y `x-forwarded-host` las
 *      manda el cliente: la seguridad del enlace dependería entonces de
 *      que la lista de Redirect URLs de Supabase nunca se configure de
 *      más (un origen fuera de la lista cae al Site URL; uno dentro, y
 *      falso, se llevaría el enlace).
 *   3. En desarrollo y en las vistas previas de Vercel (VERCEL_ENV =
 *      preview), donde el dominio cambia en cada despliegue: las
 *      cabeceras de la petición.
 *
 * Ojo: el dominio que salga de aquí tiene que estar en la lista de
 * Redirect URLs del panel de Supabase, o el enlace no vuelve (ver
 * apps/web/README.md, «Autenticación»).
 */
export class OrigenNoConfiguradoError extends Error {
  constructor() {
    super(
      "Producción sin APP_URL ni VERCEL_PROJECT_PRODUCTION_URL: el enlace mágico no sale hacia un origen deducido de las " +
        'cabeceras del cliente. Fija APP_URL (make vercel.run ARGS="env add APP_URL production").',
    );
    this.name = "OrigenNoConfiguradoError";
  }
}

/** Lo mínimo de las cabeceras que hace falta, para poder probarlo sin Next. */
export interface CabecerasDeOrigen {
  get(nombre: string): string | null;
}

/** ¿Es un despliegue de producción de verdad? Una vista previa de Vercel también compila con NODE_ENV=production. */
function esProduccion(env: Env): boolean {
  return env.NODE_ENV === "production" && env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "development";
}

const sinBarraFinal = (url: string) => url.replace(/\/+$/, "");

/** La regla, sin Next de por medio. `cabeceras` solo se lee fuera de producción. */
export function origenDesde(env: Env, cabeceras: CabecerasDeOrigen): string {
  const fijo = env.APP_URL?.trim();
  if (fijo) return sinBarraFinal(fijo);

  if (esProduccion(env)) {
    const deVercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
    if (deVercel) return sinBarraFinal(/^https?:\/\//.test(deVercel) ? deVercel : `https://${deVercel}`);
    throw new OrigenNoConfiguradoError();
  }

  const host = cabeceras.get("x-forwarded-host") ?? cabeceras.get("host") ?? "localhost:3100";
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto = cabeceras.get("x-forwarded-proto") ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

export async function origenDeLaPeticion(env: Env = process.env): Promise<string> {
  return origenDesde(env, await headers());
}
