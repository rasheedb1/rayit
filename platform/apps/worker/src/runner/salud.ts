/**
 * La salud del worker en texto de consola: una línea por job con cuándo
 * corrió, cómo terminó y cuándo terminó bien por última vez. La imprime
 * --once al terminar y `pnpm --filter @mc/worker salud`. Los datos salen
 * de getWorkerHealth (@mc/db/queries/worker).
 */
import { workerDataAsOf, type WorkerJobHealth } from '@mc/db/queries/worker';

/** «hace 3 h», «hace 2 d»: la distancia que importa al mirar si el worker está vivo. */
export function hace(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function formatHealth(rows: readonly WorkerJobHealth[], now: Date): string {
  const conHandler = rows.filter((r) => r.enabled && r.lastStatus !== null && !(r.lastStatus === 'skipped' && r.lastError === 'sin handler'));
  const nunca = rows.filter((r) => r.enabled && r.lastStatus === null);
  const lineas = conHandler.map((r) => {
    const ultima = `${r.lastStatus!.padEnd(8)} ${r.lastRunAt} (${hace(r.lastRunAt!, now)})`;
    const buena = r.lastOkAt ? `última buena ${hace(r.lastOkAt, now)}` : 'nunca terminó bien';
    const fallos = r.failedSinceOk > 0 ? ` · ${r.failedSinceOk} fallo(s) desde entonces` : '';
    return `  ${r.jobId.padEnd(26)} ${ultima} · ${buena}${fallos}`;
  });
  const datos = workerDataAsOf(rows);
  return [
    '',
    `  Salud del worker · ${now.toISOString()}`,
    '',
    ...(lineas.length ? lineas : ['  Ningún job ha corrido todavía en esta base.']),
    ...(nunca.length ? ['', `  Sin ninguna corrida: ${nunca.map((r) => r.jobId).join(', ')}`] : []),
    '',
    datos ? `  Datos al ${datos} (el recolector más atrasado).` : '  Datos al: todavía no, algún recolector no ha terminado bien nunca.',
    '',
    '',
  ].join('\n');
}
