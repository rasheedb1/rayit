/**
 * Consultas del módulo Resumen. Dueño: Rasheed (RES-1 en adelante).
 *
 * Abierto en CIM-2 con un helper de lectura sobre creator_post_board
 * para que el módulo tenga su archivo desde el día 1. Toda función
 * recibe un WorkspaceTx: RLS filtra, nadie pasa workspace_id suelto.
 */
import { desc } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { creatorPostBoard } from '../schema/index.ts';

export type PostBoardRow = typeof creatorPostBoard.$inferSelect;

/** La tabla "Mis videos": última métrica y puntaje de cada post, más reciente primero. */
export async function listPostBoard(tx: WorkspaceTx, opts: { limit?: number } = {}): Promise<PostBoardRow[]> {
  return tx.db
    .select()
    .from(creatorPostBoard)
    .orderBy(desc(creatorPostBoard.publishedAt))
    .limit(opts.limit ?? 50);
}
