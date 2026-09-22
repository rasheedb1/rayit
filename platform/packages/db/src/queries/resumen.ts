/**
 * Consultas del módulo Resumen. Dueño: Rasheed (RES-1 en adelante).
 *
 * Abierto en CIM-2 con un helper de lectura sobre creator_post_board
 * para que el módulo tenga su archivo desde el día 1. Toda función
 * recibe un WorkspaceTx: RLS filtra, nadie pasa workspace_id suelto.
 *
 * Y la regla que comparte todo queries/: un id que llega de fuera se
 * valida con `isUuid` antes de consultar (ver el bloque de
 * queries/cotizar.ts). `limit` también se valida: un NaN o un negativo
 * que llegue de un `?limit=` de la URL no tiene que llegar a Postgres.
 */
import { desc } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { creatorPostBoard } from '../schema/index.ts';

export type PostBoardRow = typeof creatorPostBoard.$inferSelect;

const DEFAULT_LIMIT = 50;
/** Techo de una página: más que esto es un error de quien llama, no una consulta. */
const MAX_LIMIT = 500;

/** La tabla "Mis videos": última métrica y puntaje de cada post, más reciente primero. */
export async function listPostBoard(tx: WorkspaceTx, opts: { limit?: number } = {}): Promise<PostBoardRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit inválido: ${String(opts.limit)}. Un entero entre 1 y ${MAX_LIMIT}.`);
  }
  return tx.db
    .select()
    .from(creatorPostBoard)
    .orderBy(desc(creatorPostBoard.publishedAt))
    .limit(limit);
}
