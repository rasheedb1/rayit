/**
 * Consultas del módulo Conexiones. Dueño: Nicolás (CON-4 en adelante).
 *
 * Abierto en CIM-2 con un helper de lectura sobre connection_health,
 * la vista que ya calcula horas desde la última sincronización y si el
 * token vence pronto. El token en sí nunca pasa por aquí: solo
 * secret_ref, y solo el worker lo resuelve.
 */
import { asc } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { connectionHealth } from '../schema/index.ts';

export type ConnectionHealthRow = typeof connectionHealth.$inferSelect;

/** Estado de cada cuenta conectada del workspace, por red y handle. */
export async function listConnectionHealth(tx: WorkspaceTx): Promise<ConnectionHealthRow[]> {
  return tx.db
    .select()
    .from(connectionHealth)
    .orderBy(asc(connectionHealth.platformId), asc(connectionHealth.handle));
}
