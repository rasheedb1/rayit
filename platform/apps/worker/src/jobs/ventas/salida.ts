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

/**
 * «lunes 28 de septiembre a las 09:01, hora estándar de Colombia»: la hora
 * de un reloj del motor en la zona del workspace. Sin paréntesis, para que
 * quepa dentro de otro («vence ya (lunes … a las 09:01, hora …)») sin
 * anidarlos.
 */
export function fechaHora(at: Date, timeZone: string): string {
  const partes = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).formatToParts(at);
  const de = (type: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === type)?.value ?? '';
  const cuando = `${de('weekday')} ${de('day')} de ${de('month')} a las ${de('hour')}:${de('minute')}`;
  const zona = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: 'longGeneric' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  return zona ? `${cuando}, ${zona}` : cuando;
}

/** Los estados de outbound_touch dichos en la terminal, en minúscula: «enviado → cancelado». */
const ESTADOS_DEL_TOQUE: Record<string, string> = {
  draft: 'borrador',
  scheduled: 'programado',
  held: 'retenido',
  processing: 'enviándose',
  sent: 'enviado',
  failed: 'no salió',
  skipped: 'saltado',
  canceled: 'cancelado',
};

/** El estado de un toque en palabras; uno que no se conoce, tal cual. */
export function estadoDelToque(status: string): string {
  return ESTADOS_DEL_TOQUE[status] ?? status;
}
