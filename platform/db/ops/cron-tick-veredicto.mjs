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
/** Tras `make cron.install`, lo que se espera a la primera respuesta antes de darla por perdida. */
export const RECIEN_MS = 2 * 60_000;
/** Peticiones esperando en net.http_request_queue a partir de las que pg_net se da por atascado. */
export const COLA_ATASCADA = 5;
/** Sin una pasada buena de outbound.dispatch en este tiempo (con el turno respondiendo), algo lo frena. */
export const DISPATCH_PARADO_MS = 30 * 60_000;

/**
 * Los cupos de Vercel Hobby que el turno gasta (apps/worker/README.md,
 * «Cupos de Hobby»). Pasarse de uno pausa el proyecto entero —la web del
 * cliente incluida— hasta el mes siguiente.
 */
export const HOBBY = {
  /** Una llamada por minuto, 30 días. */
  invocacionesMes: 1_440 * 30,
  /** La memoria de la función (Vercel, por defecto). */
  memoriaGb: 2,
  /** El cupo de memoria aprovisionada al mes. */
  cupoGbh: 360,
  /** A partir de aquí se avisa: queda poco margen para el resto de la web. */
  avisoGbh: 250,
};

/** Los GB-h al mes que gastaría el turno con `elapsedMs` de media (una llamada por minuto). */
export function gbhMes(elapsedMs) {
  return (elapsedMs / 1000) * HOBBY.invocacionesMes * HOBBY.memoriaGb / 3_600;
}

/** La fila `cron_tick` de la respuesta de la API ([{ cron_tick: {...} }]), o el objeto tal cual. */
export function estadoDe(respuesta) {
  const fila = Array.isArray(respuesta) ? respuesta[0] : respuesta;
  const estado = fila && typeof fila === 'object' && 'cron_tick' in fila ? fila.cron_tick : fila;
  return typeof estado === 'string' ? JSON.parse(estado) : estado;
}

const ms = (iso) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * ¿Se acaba de instalar? El secreto cambió o la tarea corrió por primera
 * vez hace menos de RECIEN_MS. `make cron.install` llama a status al
 * terminar, antes de que pg_net traiga la primera respuesta: eso es un
 * aviso, no un error. Una tarea sin ninguna corrida NO cuenta como
 * recién instalada: la purga diaria borra el historial de una tarea que
 * dejó de disparar hace días.
 */
export function recienInstalado(estado, ahora) {
  const secreto = ms(estado?.secreto_en_vault?.[0]?.updated_at);
  const primera = ms(estado?.tarea?.[0]?.primera_corrida);
  return [secreto, primera].some((t) => Number.isFinite(t) && ahora - t <= RECIEN_MS);
}

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

  // Las respuestas de los últimos 5 min, la más reciente primero. Para el
  // error solo cuentan las posteriores al último cambio del secreto: un
  // 401 de antes de `make cron.install` ya está resuelto.
  const recientes = (estado?.ultimas_respuestas ?? [])
    .filter((r) => ahora - ms(r.created) <= SIN_RESPUESTA_MS)
    .sort((a, b) => ms(b.created) - ms(a.created));
  const secretoCambio = ms(estado?.secreto_en_vault?.[0]?.updated_at);
  const vigentes = Number.isFinite(secretoCambio) ? recientes.filter((r) => ms(r.created) >= secretoCambio) : recientes;
  const codigo = (r) => (r.timed_out ? 'timeout' : r.status_code ?? 'sin_respuesta');
  const ultima = vigentes[0];

  if (tarea?.active && !ultima) {
    if (recienInstalado(estado, ahora)) {
      aviso('Recién instalado: el primer turno llega en 1–2 min; corre make cron.status entonces.');
    } else {
      error(`Ninguna respuesta de la ruta ${recientes.length ? 'desde que cambió el secreto en Vault' : 'en 5 min'}: pg_cron no está disparando (mira ultimas_corridas arriba) o pg_net no envía.`);
    }
  }
  // Decide la más reciente: un 401 o un 500 que ya se arregló no deja el chequeo en rojo.
  const c = ultima ? codigo(ultima) : null;
  if (c === 401) {
    error('401: el CRON_SECRET del Vault no es el de Vercel. make cron.install con el valor que tiene Vercel (o rótalo en los dos).');
  } else if (c === 500) {
    error('500: el turno falla. Mira los logs de Vercel ([cron/tick]); lo típico al integrar es que falte WORKER_DATABASE_URL.');
  } else if (c === 504) {
    error('504: el turno no respondió a tiempo (pooler de Supabase colgado o sin conexiones de sesión). Mira los logs de Vercel ([cron/tick]).');
  } else if (c === 'timeout') {
    error('pg_net dio la petición por perdida a los 60 s: la ruta tarda más que su maxDuration.');
  } else if (c === 'sin_respuesta') {
    error(`pg_net no obtuvo respuesta: ${ultima.error_msg ?? 'sin detalle'} (¿APP_URL correcta?).`);
  } else if (typeof c === 'number' && c !== 200) {
    error(`La ruta respondió ${c}: mira APP_URL (make cron.install) y los logs de Vercel.`);
  }
  // Las fallidas de antes de la última (o de antes del secreto actual): aviso, no error.
  const viejas = recientes.filter((r) => r !== ultima && codigo(r) !== 200).map(codigo);
  if (viejas.length) {
    const cuenta = [...new Set(viejas)].map((k) => `${k} ×${viejas.filter((v) => v === k).length}`).join(', ');
    aviso(`Hubo respuestas fallidas antes de la última (${cuenta}) en 5 min; la más reciente ${c === null ? 'aún no llega' : `es ${c}`}. Si se repiten, mira los logs de Vercel ([cron/tick]).`);
  }

  const noCaben = estado?.no_caben ?? [];
  if (noCaben.length) {
    error(`No caben en el turno (20 o más cortes seguidos sin terminar bien): ${noCaben.map((j) => `${j.job_id} (${j.cortes})`).join(', ')}. ` +
      'No se van a retomar: pártelos (que miren ctx.signal y se salten lo hecho) o pasa a la opción A (Pro, turnos más largos).');
  }

  const cola = Number(estado?.cola_pg_net ?? 0);
  if (cola >= COLA_ATASCADA) aviso(`pg_net tiene ${cola} petición(es) sin enviar: está atascado, y la cabecera con el secreto sigue en net.http_request_queue.`);

  const sano = !lineas.some((l) => l.nivel === 'error');
  if (sano && c === 200) {
    const buenas = recientes.filter((r) => codigo(r) === 200);
    const tiempos = buenas.map((r) => Number(/"elapsedMs":(\d+)/.exec(r.content ?? '')?.[1])).filter(Number.isFinite);
    const medio = tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : null;
    lineas.unshift({ nivel: 'ok', texto: `El turno responde: ${buenas.length} respuesta(s) 200 en 5 min${medio === null ? '' : `, ${medio} ms de media`}.` });
    // La proyección del mes, con la media de lo que guarda pg_net (unas 6 h) si la hay; si no, la de 5 min.
    const largo = Number(estado?.turno_medio?.elapsed_ms);
    const base = Number.isFinite(largo) && Number(estado?.turno_medio?.respuestas) > 0 ? largo : medio;
    if (base !== null && Number.isFinite(base)) {
      const gbh = Math.round(gbhMes(base));
      const texto = `Al ritmo de ${Math.round(base)} ms por turno, el turno gasta unos ${gbh} GB-h al mes de los ${HOBBY.cupoGbh} de Hobby`;
      if (gbh > HOBBY.avisoGbh) {
        aviso(`${texto}: pasarse pausa el proyecto entero (la web incluida) hasta el mes siguiente. Toca la opción A (Pro), README del worker, «Cupos de Hobby»; y Hobby, según los términos de Vercel, es para uso personal y no comercial.`);
      } else {
        lineas.push({ nivel: 'ok', texto: `${texto}.` });
      }
    }
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
