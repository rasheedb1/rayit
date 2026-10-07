/**
 * El error de Postgres dentro de lo que lanza una consulta.
 *
 * node-postgres lanza el error de Postgres tal cual, pero Drizzle y
 * PGlite lo envuelven en otro y lo dejan en `cause`. Todo lo que en
 * @mc/db reconoce un error por su código (23505, 23514, 42501…) y por el
 * nombre de su restricción recorre la cadena aquí, una sola vez, y nunca
 * por el texto del mensaje, que depende del idioma del servidor.
 */

/** Lo que interesa de un error de Postgres: su código SQLSTATE, la restricción y el mensaje. */
export interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

/**
 * El primer error de la cadena `cause` con ese código y, si se da, esa
 * restricción. `null` si no hay ninguno.
 */
export function findPgError(err: unknown, code: string, constraint?: string): PgLikeError | null {
  for (let e: unknown = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const p = e as PgLikeError;
    if (p.code === code && (constraint === undefined || p.constraint === constraint)) return p;
  }
  return null;
}
