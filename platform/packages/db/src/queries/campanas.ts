/**
 * Consultas del módulo Campañas. Dueño: Nicolás (CAM-1 en adelante).
 *
 * Abierto en CIM-2 con un helper de lectura para que el módulo tenga
 * su archivo desde el día 1. createCampaignFromQuote() (CAM-2) es el
 * contrato con Cotizar: Rasheed lo llama, no inserta en campaign.
 */
import { desc } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { campaign } from '../schema/index.ts';

export type Campaign = typeof campaign.$inferSelect;

/** Las campañas del workspace, más recientes primero. */
export async function listCampaigns(tx: WorkspaceTx): Promise<Campaign[]> {
  return tx.db.select().from(campaign).orderBy(desc(campaign.createdAt));
}
