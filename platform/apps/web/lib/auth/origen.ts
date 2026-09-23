import "server-only";
import { headers } from "next/headers";

/**
 * El origen público de esta aplicación (`https://on-cue-web.vercel.app`,
 * `http://localhost:3100`), que es a donde Supabase devuelve el enlace
 * mágico.
 *
 * APP_URL manda cuando está fijada —es la que ya usa el OAuth de
 * Conexiones (CON-3) y la única que un correo puede citar sin
 * equivocarse detrás de un proxy—. Si no está, se arma con las
 * cabeceras de la petición, que es lo que hace falta en local y en las
 * vistas previas de Vercel, donde el dominio cambia en cada despliegue.
 *
 * Ojo: el dominio que salga de aquí tiene que estar en la lista de
 * Redirect URLs del panel de Supabase, o el enlace no vuelve (ver
 * apps/web/README.md, «Autenticación»).
 */
export async function origenDeLaPeticion(): Promise<string> {
  const fijo = process.env.APP_URL?.trim();
  if (fijo) return fijo.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
