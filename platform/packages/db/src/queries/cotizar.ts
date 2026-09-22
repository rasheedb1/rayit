/**
 * Consultas del módulo Cotizar. Dueño: Rasheed (COT-1 en adelante).
 *
 * Abierto en CIM-2 con la lectura del tarifario vigente. La fórmula
 * del rango vive en packages/core (tarifas.ts, COT-1); aquí solo se
 * lee y se escribe lo que ya está calculado.
 *
 * REGLA PARA QUIEN SIGA ESTE ARCHIVO (vale para todo queries/): un id
 * que llega de fuera —una ruta, un formulario— se valida con `isUuid`
 * ANTES de consultar. Drizzle parametriza, así que no hay inyección,
 * pero `/cotizar/no-soy-uuid` acabaría en un 22P02 de Postgres
 * convertido en 500 en vez del 404 del producto. Una búsqueda por id
 * que ya devuelve `null` cuando no encuentra nada devuelve `null`
 * también aquí: para la pantalla, un id imposible y un id que no existe
 * son lo mismo. Lo que escribe (createX) sí lanza, con su error con
 * messageEs.
 */
import { and, asc, eq } from 'drizzle-orm';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { rateCard, rateCardItem } from '../schema/index.ts';

export type RateCard = typeof rateCard.$inferSelect;
export type RateCardItem = typeof rateCardItem.$inferSelect;

/** El tarifario vigente de un creador con sus entregables en orden, o null si no tiene. */
export async function getCurrentRateCard(
  tx: WorkspaceTx,
  creatorId: string,
): Promise<{ card: RateCard; items: RateCardItem[] } | null> {
  if (!isUuid(creatorId)) return null;
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
