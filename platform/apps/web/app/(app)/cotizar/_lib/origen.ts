/**
 * De dónde viene una visita a un enlace público, para el bloqueo POR
 * ORIGEN de contraseñas fallidas del media kit (migración 0030) y para
 * el freno en memoria de _lib/limite.ts.
 *
 * Es la IP que dejó el proxy delante de la aplicación: en Vercel,
 * `x-forwarded-for` y `x-real-ip` los escribe la plataforma y el
 * navegador no los puede falsear. Detrás de un proxy que los deja pasar
 * tal cual, quien ataca puede inventar un origen por petición; para eso
 * está el techo POR ENLACE de la base (50 fallos por hora sumando todos
 * los orígenes), que no depende de este valor.
 *
 * La base no guarda lo que devuelve esta función: lo resume con el id
 * del kit (sha256) y guarda el resumen.
 */
export const SIN_ORIGEN = "sin-ip";

export function origenDeLaPeticion(h: Pick<Headers, "get">): string {
  const reenviada = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const origen = reenviada || h.get("x-real-ip")?.trim() || SIN_ORIGEN;
  // Una cabecera no es un campo de texto libre: el tope evita que una
  // cabecera enorme viaje hasta la base.
  return origen.slice(0, 64);
}
