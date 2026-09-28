/**
 * La salud del worker en texto de consola: una línea por job con cuándo
 * corrió, cómo terminó y cuándo terminó bien por última vez. La imprime
 * --once al terminar y `pnpm --filter @mc/worker salud`. Los asOf salen
 * de getWorkerHealth (@mc/db/queries/worker).
 */
import { MAX_TICK_CUTS, workerDataAsOf, type WorkerJobHealth } from '@mc/db/queries/worker';
import { SKIPPED_NO_HANDLER } from './worker.ts';

/** «hace 3 h», «hace 2 d»: la distancia que importa al mirar si el worker está vivo. */
export function timeAgo(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function formatHealth(rows: readonly WorkerJobHealth[], now: Date): string {
  const withHandler = rows.filter((r) => r.enabled && r.lastStatus !== null && !(r.lastStatus === 'skipped' && r.lastError === SKIPPED_NO_HANDLER));
  const neverRan = rows.filter((r) => r.enabled && r.lastStatus === null);
  const lines = withHandler.map((r) => {
    // Un corte del turno (CIM-7) no es un fallo: la fila dice failed/timeout, pero el turno siguiente la retoma.
    // Salvo que no quepa nunca: con MAX_TICK_CUTS cortes seguidos no se va a retomar.
    const status = !r.lastCut ? r.lastStatus!.padEnd(8)
      : r.cutsSinceOk >= MAX_TICK_CUTS ? `no cabe en el turno (${r.cutsSinceOk} cortes): súbelo a Pro o pártelo · último corte`
      : 'cortado por el turno, se retoma';
    const last = `${status} ${r.lastRunAt} (${timeAgo(r.lastRunAt!, now)})`;
    const lastOk = r.lastOkAt ? `última buena ${timeAgo(r.lastOkAt, now)}` : 'nunca terminó bien';
    const failures = r.failedSinceOk > 0 ? ` · ${r.failedSinceOk} fallo(s) desde entonces` : '';
    return `  ${r.jobId.padEnd(26)} ${last} · ${lastOk}${failures}`;
  });
  const asOf = workerDataAsOf(rows);
  return [
    '',
    `  Salud del worker · ${now.toISOString()}`,
    '',
    ...(lines.length ? lines : ['  Ningún job ha corrido todavía en esta base.']),
    ...(neverRan.length ? ['', `  Sin ninguna corrida: ${neverRan.map((r) => r.jobId).join(', ')}`] : []),
    '',
    asOf ? `  Datos al ${asOf} (el recolector más atrasado).` : '  Datos al: todavía no, algún recolector no ha terminado bien nunca.',
    '',
    '',
  ].join('\n');
}
