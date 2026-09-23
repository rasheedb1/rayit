/**
 * Fechas de calendario en la zona del workspace.
 *
 * La app guarda instantes en UTC, pero el creador elige días: «este
 * enlace vence el 30 de septiembre» quiere decir hasta el final del 30
 * en SU zona. Si se guardara `2026-09-30T23:59:59Z`, en Bogotá el
 * enlace dejaría de abrir a las 18:59 de ese día.
 *
 * Solo Intl: nada de tablas de husos a mano, y el cambio de horario lo
 * resuelve el motor.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const cache = new Map<string, Intl.DateTimeFormat>();
function partes(timeZone: string): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    cache.set(timeZone, f);
  }
  return f;
}

/** Cuántos milisegundos va la zona por delante de UTC en ese instante (Bogotá: −5 h). */
function desfase(instante: number, timeZone: string): number {
  const p = Object.fromEntries(partes(timeZone).formatToParts(new Date(instante)).map((x) => [x.type, x.value]));
  const comoUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return comoUtc - Math.floor(instante / 1000) * 1000;
}

/**
 * El último segundo de un día de calendario en una zona, como instante
 * ISO en UTC: finDelDiaEnZona('2026-09-30', 'America/Bogota') →
 * '2026-10-01T04:59:59.000Z'. Lanza si la fecha o la zona no valen.
 */
export function finDelDiaEnZona(fecha: string, timeZone: string): string {
  const m = ISO_DATE_RE.exec(fecha);
  if (!m) throw new Error(`No es una fecha 'YYYY-MM-DD': "${fecha}".`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const local = Date.UTC(y, mo - 1, d, 23, 59, 59);
  const check = new Date(local);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new Error(`Fecha inexistente: "${fecha}".`);
  }
  // Dos pasadas: la segunda corrige si entre la conjetura y el
  // resultado hay un cambio de horario.
  let instante = local - desfase(local, timeZone);
  instante = local - desfase(instante, timeZone);
  return new Date(instante).toISOString();
}

/** El día de hoy ('YYYY-MM-DD') en una zona. */
export function hoyEnZona(timeZone: string, ahora: Date = new Date()): string {
  const p = Object.fromEntries(partes(timeZone).formatToParts(ahora).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
