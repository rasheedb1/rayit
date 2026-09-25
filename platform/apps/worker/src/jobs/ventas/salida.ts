/**
 * Cómo escriben en la terminal los comandos del motor (job:dispatch,
 * job:replies y la demo): cifras con su singular o plural y horas en la
 * zona del workspace, con Intl, como la web. Es la experiencia de quien
 * integra; no es una pantalla, así que va en español.
 */

const LOCALE = 'es-CO';
const REGLAS = new Intl.PluralRules(LOCALE);
const CIFRA = new Intl.NumberFormat(LOCALE);

/** «1 enviado», «0 enviados», «2 enviados». */
export function cuenta(n: number, uno: string, varios: string): string {
  return `${CIFRA.format(n)} ${REGLAS.select(n) === 'one' ? uno : varios}`;
}

/** «lunes, 28 de septiembre, 09:01 (hora de Colombia)»: la hora de un reloj del motor en la zona del workspace. */
export function fechaHora(at: Date, timeZone: string): string {
  const cuando = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).format(at);
  const zona = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: 'longGeneric' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  return zona ? `${cuando} (${zona})` : cuando;
}
