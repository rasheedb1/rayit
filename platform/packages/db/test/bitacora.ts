/**
 * Leer la bitácora en las pruebas (ACC-2). Nunca pide el id: es un
 * bigserial que no sale de la base (CIM-2 §3).
 */
import type { TestDb } from './pglite.ts';

export interface FilaBitacora {
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}

/** Las filas de una entidad (y opcionalmente una acción) vistas desde un workspace, en orden de escritura. */
export async function filasDeBitacora(t: TestDb, workspaceId: string, entityId: string, action?: string): Promise<FilaBitacora[]> {
  const { rows } = await t.db.withWorkspace(workspaceId, (tx) =>
    tx.query<FilaBitacora>(
      `SELECT actor_user_id, actor_kind, action, entity_type, entity_id, before, after
         FROM audit_log
        WHERE entity_id = $1 AND ($2::text IS NULL OR action = $2)
        ORDER BY created_at, action`,
      [entityId, action ?? null],
    ),
  );
  return rows;
}
