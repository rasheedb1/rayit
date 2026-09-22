/**
 * Consultas del módulo Cotizar. Dueño: Rasheed (COT-1 en adelante).
 *
 * Abierto en CIM-2 con la lectura del tarifario vigente. La fórmula
 * del rango vive en packages/core (tarifas.ts, COT-1); aquí solo se
 * lee y se escribe lo que ya está calculado.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { rateCard, rateCardItem } from '../schema/index.ts';

export type RateCard = typeof rateCard.$inferSelect;
export type RateCardItem = typeof rateCardItem.$inferSelect;

/** El tarifario vigente de un creador con sus entregables en orden, o null si no tiene. */
export async function getCurrentRateCard(
  tx: WorkspaceTx,
  creatorId: string,
): Promise<{ card: RateCard; items: RateCardItem[] } | null> {
  const [card] = await tx.db
    .select()
    .from(rateCard)
    .where(and(eq(rateCard.creatorId, creatorId), eq(rateCard.isCurrent, true)))
    .limit(1);
  if (!card) return null;
  const items = await tx.db
    .select()
    .from(rateCardItem)
    .where(eq(rateCardItem.rateCardId, card.id))
    .orderBy(asc(rateCardItem.position));
  return { card, items };
}
