/**
 * El error de Postgres dentro de lo que lanza una consulta.
 *
 * node-postgres lanza el error de Postgres tal cual, pero Drizzle y
 * PGlite lo envuelven en otro y lo dejan en `cause`. Todo lo que en
 * @mc/db (y en la web) busca un error de Postgres (23505, 23514,
 * 42501…) recorre la cadena aquí: `findInCauseChain` es el recorrido, y
 * `findPgError` la pregunta de siempre encima de él: por su código y el
 * nombre de su restricción, nunca por el texto
 * del mensaje, que depende del idioma del servidor. La única excepción
 * es la que Postgres no deja en ningún campo —qué política rechazó una
 * fila—, y para eso está `matches` (scopeErrorOf).
 */
import type { SqlExecutor } from './client.ts';

/** Lo que interesa de un error de Postgres: su código SQLSTATE, la restricción y el mensaje. */
export interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

/** Más eslabones que esto no los arma nadie: es el tope ante una cadena circular. */
const MAX_ESLABONES = 32;

/**
 * El primer eslabón de la cadena `cause` (empezando por el propio error)
 * que cumple `matches`, o `null`. Solo recorre objetos: un `cause` que
 * no lo es termina la cadena.
 */
export function findInCauseChain(err: unknown, matches: (e: PgLikeError) => boolean): PgLikeError | null {
  let e: unknown = err;
  for (let i = 0; typeof e === 'object' && e !== null && i < MAX_ESLABONES; i++) {
    if (matches(e as PgLikeError)) return e as PgLikeError;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * El primer error de la cadena `cause` con ese código, esa restricción
 * (si se da) y que cumpla `matches` (si se da). `null` si no hay ninguno.
 */
export function findPgError(
  err: unknown,
  code: string,
  constraint?: string,
  matches?: (p: PgLikeError) => boolean,
): PgLikeError | null {
  return findInCauseChain(
    err,
    (p) =>
      p.code === code &&
      (constraint === undefined || p.constraint === constraint) &&
      (matches === undefined || matches(p)),
  );
}

/**
 * Los SAVEPOINT de @mc/db: identificadores fijos de los módulos que usan
 * withSavepoint. Es una unión y no un `string` para que el SQL que se
 * arma con ellos no pueda recibir otra cosa; uno nuevo se añade aquí.
 */
export type SavepointName = 'campana_de_cotizacion' | 'autorizar_cuenta_por_arroba' | 'cambio_de_rol';
const SAVEPOINT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Una escritura que puede fallar con un error que se sabe leer (un
 * choque con un índice único, un disparador) sin dejar la transacción
 * abortada.
 *
 * `fn` corre dentro de `SAVEPOINT name`. Si termina, RELEASE. Si lanza,
 * ROLLBACK TO y RELEASE, y entonces `onError(err)` decide: devolver lo
 * que la llamada entiende, o lanzar. Sin `onError`, el error se relanza
 * tal cual. Es el único recorrido SAVEPOINT / ROLLBACK TO / RELEASE de
 * @mc/db (writeOrScopeError en scope.ts, changeMemberRole en equipo.ts).
 *
 * Si la vuelta al SAVEPOINT falla (la conexión se cayó, la transacción ya
 * estaba rota), se lanza el error ORIGINAL, que es el que explica lo que
 * pasó, sin llamar a `onError`: con la transacción inservible no hay nada
 * que preguntarle a la base. El de la vuelta queda en su `cause` si el
 * original no traía uno.
 *
 * `name` va dentro del SQL: además del tipo, se comprueba que sea un
 * identificador simple antes de escribir nada, por si llega con un cast
 * desde JavaScript.
 */
export async function withSavepoint<T, E = never>(
  tx: SqlExecutor,
  name: SavepointName,
  fn: () => Promise<T>,
  onError?: (err: unknown) => Promise<E> | E,
): Promise<T | E> {
  if (!SAVEPOINT_RE.test(name)) throw new TypeError(`SAVEPOINT no válido: ${JSON.stringify(name)}`);
  await tx.query(`SAVEPOINT ${name}`);
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    try {
      await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await tx.query(`RELEASE SAVEPOINT ${name}`);
    } catch (vuelta) {
      conCausa(err, vuelta);
      throw err;
    }
    if (!onError) throw err;
    return onError(err);
  }
  await tx.query(`RELEASE SAVEPOINT ${name}`);
  return out;
}

/** Deja `causa` en el `cause` de `err` si no traía uno y se puede escribir. Nunca lanza. */
function conCausa(err: unknown, causa: unknown): void {
  if (typeof err !== 'object' || err === null || (err as { cause?: unknown }).cause !== undefined) return;
  try {
    (err as { cause?: unknown }).cause = causa;
  } catch {
    // Un error congelado: se lanza igual, sin la causa.
  }
}
