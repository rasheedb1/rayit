/**
 * El proceso largo y el turno (CIM-7) no corren a la vez contra la misma
 * base. pg-boss no mira job_run y el turno no mira pg-boss: juntos, cada
 * job con cron corre dos veces (dos generaciones con Anthropic, avisos
 * duplicados). Pasa sin querer: `make db.unlock` deja un .env.local que
 * apunta a PRODUCCIÓN, y un `pnpm --filter @mc/worker start` en el
 * portátil de alguien se cruza con el pg_cron de Supabase.
 *
 * Tres piezas, las tres en la base (lo único que ven los dos lados):
 *
 *   1. El proceso largo toma, en una conexión suya que retiene mientras
 *      vive, un candado de sesión (pg_try_advisory_lock de
 *      LONG_PROCESS_LOCK). Si otro ya lo tiene, no arranca.
 *   2. El turno, antes de hacer nada, mira en pg_locks si ese candado lo
 *      tiene otra sesión. Si lo tiene, no corre nada y lo dice.
 *   3. El proceso largo no arranca si hubo turnos en los últimos
 *      RECENT_TICK_WINDOW_MS (filas de job_run que abrió un turno), salvo
 *      WORKER_ALLOW_WITH_TICK=1: es el caso de arriba visto desde el otro
 *      lado, cuando el turno ya está instalado y el proceso largo llega
 *      después. El candado solo no bastaría: el turno lo respeta, pero
 *      las corridas que ese turno ya empezó no.
 *
 * Por qué pg_locks y no pg_try_advisory_xact_lock en el turno: dos
 * turnos solapados se verían el candado de transacción el uno al otro y
 * uno de los dos saldría sin correr nada. Mirar pg_locks no toma nada.
 *
 * PGlite tiene una sola sesión: el candado siempre es «propio» y el
 * turno nunca lo ve de otro. Lo cubre test/tick-postgres.test.ts contra
 * Postgres de verdad.
 */
import pg from 'pg';
import { ConfigError, type Env } from './config.ts';
import type { BossConnection, Queryable } from './db.ts';
import type { Logger } from './logger.ts';
import { TICK_RUN_PREFIX, SLICE_KEY } from './once.ts';

/** La clave del candado del proceso largo: hashtextextended(LONG_PROCESS_LOCK, 0). */
export const LONG_PROCESS_LOCK = 'mc-worker:proceso-largo';
/** Cuánto hacia atrás cuenta un turno como «instalado y corriendo». */
export const RECENT_TICK_WINDOW_MS = 5 * 60_000;
/** La variable que deja arrancar el proceso largo aunque haya turnos recientes, a sabiendas. */
export const ALLOW_WITH_TICK_ENV = 'WORKER_ALLOW_WITH_TICK';

/**
 * ¿Tiene OTRA sesión el candado del proceso largo? Una consulta a
 * pg_locks, sin tomar nada. Un candado de sesión con clave bigint sale en
 * pg_locks con los 32 bits altos en classid, los bajos en objid y
 * objsubid = 1.
 */
export async function longProcessHoldsLock(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid() AND l.objsubid = 1
          AND l.classid::bigint = ((k.v >> 32) & 4294967295) AND l.objid::bigint = (k.v & 4294967295)
     ) AS held
     FROM (SELECT hashtextextended($1, 0) AS v) k`,
    [LONG_PROCESS_LOCK],
  );
  return rows[0]?.held === true;
}

export interface LongProcessLock {
  /** Suelta el candado y cierra su conexión. Se puede llamar más de una vez. */
  release(): Promise<void>;
}

export interface HoldLockOptions {
  /** La conexión sin cambio de rol (db.bossConnection()): la URL y el TLS ya resueltos. */
  connection: BossConnection;
  applicationName: string;
  logger: Logger;
  /** Si la conexión del candado se cae, el candado se pierde: quien llama decide qué hacer (el worker se detiene). */
  onLost?: (err: Error) => void;
}

/**
 * Toma el candado del proceso largo en una conexión dedicada y la
 * retiene. Si otra sesión ya lo tiene, cierra la suya y lanza
 * ConfigError: hay otro proceso largo contra esta base.
 */
export async function holdLongProcessLock(opts: HoldLockOptions): Promise<LongProcessLock> {
  const client = new pg.Client({
    connectionString: opts.connection.connectionString,
    ssl: opts.connection.ssl,
    application_name: opts.applicationName,
  });
  let released = false;
  client.on('error', (err) => {
    if (released) return;
    opts.logger.error('se perdió la conexión del candado del proceso largo: el turno ya no lo ve', { err });
    opts.onLost?.(err);
  });
  await client.connect();
  let ok = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [LONG_PROCESS_LOCK]);
    ok = rows[0]?.ok === true;
  } finally {
    if (!ok) {
      released = true;
      await client.end().catch(() => undefined);
    }
  }
  if (!ok) {
    throw new ConfigError(
      'Ya hay un proceso largo del worker contra esta base (tiene el candado ' + LONG_PROCESS_LOCK + '). ' +
        'Dos correrían cada job dos veces. Si es tu .env.local de `make db.unlock`, apunta a PRODUCCIÓN: ' +
        'para probar en local usa WORKER_DATABASE_URL con tu Postgres de Docker, o `--pglite`.',
    );
  }
  opts.logger.info('candado del proceso largo tomado: el turno no corre mientras este proceso viva', { lock: LONG_PROCESS_LOCK });
  return {
    async release() {
      if (released) return;
      released = true;
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LONG_PROCESS_LOCK]).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

/**
 * El proceso largo no arranca si un turno corrió hace menos de
 * RECENT_TICK_WINDOW_MS: el cron de Supabase (o de Vercel) está instalado
 * contra esta base y los dos correrían lo mismo. Una fila es de un turno
 * si su bossJobId empieza por TICK_RUN_PREFIX o lleva SLICE_KEY.
 * WORKER_ALLOW_WITH_TICK=1 lo deja pasar a sabiendas.
 */
export async function assertNoRecentTicks(db: Queryable, env: Env, now: Date = new Date()): Promise<void> {
  if (env[ALLOW_WITH_TICK_ENV] === '1') return;
  const since = new Date(now.getTime() - RECENT_TICK_WINDOW_MS);
  const { rows } = await db.query<{ n: number | string; last: Date | string | null }>(
    `SELECT count(*)::int AS n, max(started_at) AS last FROM job_run
      WHERE started_at > $1::timestamptz
        AND (metadata->>'bossJobId' LIKE $2 OR metadata ? $3)`,
    [since.toISOString(), `${TICK_RUN_PREFIX}%`, SLICE_KEY],
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) return;
  const last = rows[0]?.last ? new Date(rows[0].last).toISOString() : '—';
  throw new ConfigError(
    `El modo por turnos está corriendo contra esta base (${n} corridas de turnos en los últimos ${RECENT_TICK_WINDOW_MS / 60_000} min; ` +
      `la última, ${last}). El proceso largo y el turno a la vez corren cada job dos veces. Si es tu .env.local de ` +
      '`make db.unlock`, apunta a PRODUCCIÓN. Para apagar el turno: `make cron.uninstall`. ' +
      `${ALLOW_WITH_TICK_ENV}=1 arranca igual, a sabiendas.`,
  );
}
