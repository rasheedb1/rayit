/**
 * El error de Postgres dentro de lo que lanza una consulta.
 *
 * node-postgres lanza el error de Postgres tal cual, pero Drizzle y
 * PGlite lo envuelven en otro y lo dejan en `cause`. Todo lo que en
 * @mc/db (y en la web) reconoce un error de Postgres (23505, 23514,
 * 42501…) recorre la cadena aquí: `findInCauseChain` es el único
 * recorrido de `cause`, y `findPgError` la pregunta de siempre encima
 * de él: por su código y el nombre de su restricción, nunca por el texto
 * del mensaje, que depende del idioma del servidor. La única excepción
 * es la que Postgres no deja en ningún campo —qué política rechazó una
 * fila—, y para eso está `matches` (scopeErrorOf).
 */

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
