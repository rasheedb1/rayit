/**
 * Textos de Conexiones que nacen con ACC-8 (consentimiento delegado):
 * el aviso al titular, la línea «Conectada por …» de la lista y el
 * mensaje de «sin permiso». Un solo sitio por módulo para que
 * traducirlos o corregirlos no sea buscar por el árbol.
 *
 * Las funciones reciben cifras y fechas YA formateadas por
 * lib/format.ts (formatterFor del workspace): aquí no se formatea nada.
 * Los textos anteriores del módulo (la declaración de propiedad, el
 * texto del consentimiento OAuth, los errores del flujo) siguen donde
 * nacieron: consent.ts, cuentas-service.ts y oauth-handlers.ts.
 */
export const MESSAGES = {
  permiso: {
    /** Server Action o ruta OAuth con un rol que no tiene conexiones.cuenta.conectar / .desconectar. */
    conectar: "No tienes permiso para conectar cuentas en este espacio. Pídeselo a su dueño.",
    desconectar: "No tienes permiso para quitar cuentas en este espacio. Pídeselo a su dueño.",
  },
  aviso: {
    /** notification.title_es del kind connection_added. */
    title: "Una cuenta se conectó en tu nombre",
    /** notification.body_es: quién (nombre o correo), qué cuenta, en qué red y cuándo (fecha ya formateada). */
    body: (p: { who: string; handle: string; network: string; when: string }): string =>
      `${p.who} conectó la cuenta @${p.handle} de ${p.network} el ${p.when} en tu nombre. Puedes quitarla cuando quieras desde Cuentas.`,
  },
  lista: {
    /** Debajo del @ en la lista, solo cuando la conectó un tercero. */
    conectadaPor: (p: { who: string; when: string }): string => `Conectada por ${p.who} el ${p.when}`,
    /** Quien conectó ya no es miembro y la evidencia no guardó correo: nunca un guion mudo. */
    alguienDelEquipo: "alguien del equipo",
  },
} as const;

/** El nombre de una persona para una frase: su nombre y, si no lo puso, su correo. */
export function nombreDe(p: { name: string | null; email: string | null }): string | null {
  return p.name?.trim() || p.email || null;
}
