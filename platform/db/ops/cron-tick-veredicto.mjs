#!/usr/bin/env node
/**
 * El veredicto de `make cron.status` (CIM-7): lee la fila de
 * db/ops/cron-tick-estado.sql (la respuesta de la API de administración,
 * por la entrada estándar) y dice en una línea si el turno está sano y,
 * si no, qué hacer. Sale con 1 si no lo está: sirve como chequeo.
 *
 *   ./scripts/supabase-admin.sh sql-stdin < db/ops/cron-tick-estado.sql | node db/ops/cron-tick-veredicto.mjs
 *
 * Lo más probable al integrar es un CRON_SECRET distinto entre Vercel y
 * el Vault (401 cada minuto) o que falte WORKER_DATABASE_URL en Vercel
 * (500): los dos dejan de enviar sin que nada lo diga, y aquí se ven de
 * un vistazo. No imprime el cuerpo de las respuestas (lo muestra el JSON
 * de arriba) ni nada de Vault salvo que el secreto exista.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Sin ninguna respuesta de pg_net en este tiempo, pg_cron no está disparando. */
export const SIN_RESPUESTA_MS = 5 * 60_000;
/** Peticiones esperando en net.http_request_queue a partir de las que pg_net se da por atascado. */
export const COLA_ATASCADA = 5;
/** Sin una pasada buena de outbound.dispatch en este tiempo (con el turno respondiendo), algo lo frena. */
export const DISPATCH_PARADO_MS = 30 * 60_000;

/** La fila `cron_tick` de la respuesta de la API ([{ cron_tick: {...} }]), o el objeto tal cual. */
export function estadoDe(respuesta) {
  const fila = Array.isArray(respuesta) ? respuesta[0] : respuesta;
  const estado = fila && typeof fila === 'object' && 'cron_tick' in fila ? fila.cron_tick : fila;
  return typeof estado === 'string' ? JSON.parse(estado) : estado;
}

const ms = (iso) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * { sano, lineas: [{ nivel: 'ok' | 'error' | 'aviso', texto }] } a partir del estado.
 * El primer error decide; los avisos no tumban el chequeo.
 */
export function veredicto(estado) {
  const lineas = [];
  const error = (texto) => lineas.push({ nivel: 'error', texto });
  const aviso = (texto) => lineas.push({ nivel: 'aviso', texto });
  const ahora = ms(estado?.ahora) || Date.now();

  const tarea = estado?.tarea?.[0];
  if (!tarea) error('La tarea on-cue-tick no existe: el turno no corre. make cron.install la programa.');
  else if (!tarea.active) error('La tarea on-cue-tick está desactivada en pg_cron: el turno no corre. make cron.install la vuelve a programar.');
  if (!estado?.secreto_en_vault?.length) error('No hay secreto en Vault (on_cue_cron_secret): la tarea no llama. make cron.install con el CRON_SECRET de Vercel.');

  const recientes = (estado?.ultimas_respuestas ?? []).filter((r) => ahora - ms(r.created) <= SIN_RESPUESTA_MS);
  if (tarea?.active && recientes.length === 0) {
    error('Ninguna respuesta de la ruta en 5 min: pg_cron no está disparando (mira ultimas_corridas arriba) o pg_net no envía.');
  }
  const codigos = recientes.map((r) => (r.timed_out ? 'timeout' : r.status_code ?? 'sin_respuesta'));
  if (codigos.includes(401)) {
    error('401: el CRON_SECRET del Vault no es el de Vercel. make cron.install con el valor que tiene Vercel (o rótalo en los dos).');
  }
  if (codigos.some((c) => c === 500)) {
    error('500: el turno falla. Mira los logs de Vercel ([cron/tick]); lo típico al integrar es que falte WORKER_DATABASE_URL.');
  }
  if (codigos.includes(504)) {
    error('504: el turno no respondió a tiempo (pooler de Supabase colgado o sin conexiones de sesión). Mira los logs de Vercel ([cron/tick]).');
  }
  if (codigos.includes('timeout')) error('pg_net dio la petición por perdida a los 60 s: la ruta tarda más que su maxDuration.');
  if (codigos.includes('sin_respuesta')) {
    error(`pg_net no obtuvo respuesta: ${recientes.find((r) => !r.timed_out && r.status_code == null)?.error_msg ?? 'sin detalle'} (¿APP_URL correcta?).`);
  }
  const otros = [...new Set(codigos.filter((c) => typeof c === 'number' && c !== 200 && ![401, 500, 504].includes(c)))];
  if (otros.length) error(`La ruta respondió ${otros.join(', ')}: mira APP_URL (make cron.install) y los logs de Vercel.`);

  const cola = Number(estado?.cola_pg_net ?? 0);
  if (cola >= COLA_ATASCADA) aviso(`pg_net tiene ${cola} petición(es) sin enviar: está atascado, y la cabecera con el secreto sigue en net.http_request_queue.`);

  const sano = !lineas.some((l) => l.nivel === 'error');
  if (sano) {
    const tiempos = recientes.map((r) => Number(/"elapsedMs":(\d+)/.exec(r.content ?? '')?.[1])).filter(Number.isFinite);
    const medio = tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : null;
    lineas.unshift({ nivel: 'ok', texto: `El turno responde: ${recientes.length} respuesta(s) 200 en 5 min${medio === null ? '' : `, ${medio} ms de media`}.` });
    const dispatch = ms(estado?.dispatch_ultimo_ok);
    if (!Number.isFinite(dispatch)) aviso('outbound.dispatch no ha terminado bien nunca en esta base: ¿hay algún workspace con outreach encendido?');
    else if (ahora - dispatch > DISPATCH_PARADO_MS) aviso(`La última pasada buena de outbound.dispatch fue hace ${Math.round((ahora - dispatch) / 60_000)} min (corre cada 2): mira job_run.`);
  }
  return { sano, lineas };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let v;
  try {
    v = veredicto(estadoDe(JSON.parse(readFileSync(0, 'utf8'))));
  } catch (err) {
    console.error(`  No se pudo leer el estado del turno: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const color = { ok: '32', aviso: '33', error: '31' };
  for (const l of v.lineas) {
    const out = l.nivel === 'error' ? process.stderr : process.stdout;
    out.write(`\u001b[${color[l.nivel]}m  ${l.texto}\u001b[0m\n`);
  }
  process.exit(v.sano ? 0 : 1);
}
