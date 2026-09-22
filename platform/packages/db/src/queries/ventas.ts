/**
 * Consultas del módulo Ventas. Dueño: Rasheed (VEN-1 en adelante).
 *
 * Abierto en CIM-2 con un helper de lectura sobre deal_pipeline, la
 * vista que ya resuelve probabilidad, monto ponderado y estado del
 * seguimiento; ninguna pantalla vuelve a calcularlos.
 *
 * Y la regla que comparte todo queries/: un id que llega de fuera se
 * valida con `isUuid` antes de consultar, y una búsqueda por id
 * devuelve `null` cuando el id es imposible, igual que cuando no
 * existe (ver el bloque de queries/cotizar.ts).
 */
import { asc, eq } from 'drizzle-orm';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { dealPipeline } from '../schema/index.ts';

export type PipelineRow = typeof dealPipeline.$inferSelect;

/** Los deals del workspace por etapa y, dentro de cada una, por fecha de siguiente acción. */
export async function listPipeline(tx: WorkspaceTx): Promise<PipelineRow[]> {
  return tx.db
    .select()
    .from(dealPipeline)
    .orderBy(asc(dealPipeline.stagePosition), asc(dealPipeline.nextActionDue));
}

/** Un deal del workspace por su id, o null si no existe (o no es suyo, o el id es imposible). */
export async function getPipelineDeal(tx: WorkspaceTx, dealId: string): Promise<PipelineRow | null> {
  if (!isUuid(dealId)) return null;
  const [row] = await tx.db.select().from(dealPipeline).where(eq(dealPipeline.id, dealId)).limit(1);
  return row ?? null;
}
