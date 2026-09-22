/**
 * Consultas del módulo Ventas. Dueño: Rasheed (VEN-1 en adelante).
 *
 * Abierto en CIM-2 con un helper de lectura sobre deal_pipeline, la
 * vista que ya resuelve probabilidad, monto ponderado y estado del
 * seguimiento; ninguna pantalla vuelve a calcularlos.
 */
import { asc } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { dealPipeline } from '../schema/index.ts';

export type PipelineRow = typeof dealPipeline.$inferSelect;

/** Los deals del workspace por etapa y, dentro de cada una, por fecha de siguiente acción. */
export async function listPipeline(tx: WorkspaceTx): Promise<PipelineRow[]> {
  return tx.db
    .select()
    .from(dealPipeline)
    .orderBy(asc(dealPipeline.stagePosition), asc(dealPipeline.nextActionDue));
}
