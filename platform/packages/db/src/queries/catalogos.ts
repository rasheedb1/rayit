/**
 * Los catálogos del producto: las tablas globales sin RLS que se leen
 * ANTES de que haya un workspace fijado. Dueño: CIM (cimientos).
 *
 * Son siete y están aquí con nombre a propósito. El cliente sabe abrir
 * una transacción sin workspace (`withCatalogs`), pero esa puerta no
 * sale del barril de `@mc/db`: sobre una tabla con RLS devuelve cero
 * filas en silencio, y quien la use por descuido verá una lista vacía y
 * buscará el error en la pantalla. Pedir un catálogo por su nombre no
 * tiene esa trampa.
 *
 * `company` y `contact` NO son catálogos aunque `company` no tenga
 * workspace_id: la relación con un workspace vive en `company_link`, y
 * `contact` lleva RLS propia desde la migración 0019 (PII). Se leen
 * dentro de `withWorkspace`.
 */
import { asc, isNull, or, eq } from 'drizzle-orm';
import type { CatalogDb } from '../client.ts';
import {
  featureFlag, jobDefinition, niche, nicheCpmBenchmark, pipelineStage, platform, signalSource,
} from '../schema/index.ts';

export type Platform = typeof platform.$inferSelect;
export type Niche = typeof niche.$inferSelect;
export type NicheCpmBenchmark = typeof nicheCpmBenchmark.$inferSelect;
export type PipelineStage = typeof pipelineStage.$inferSelect;
export type SignalSource = typeof signalSource.$inferSelect;
export type FeatureFlag = typeof featureFlag.$inferSelect;
export type JobDefinition = typeof jobDefinition.$inferSelect;

/** Las cuatro redes, con sus límites y capacidades. */
export async function listPlatforms(db: CatalogDb): Promise<Platform[]> {
  return db.withCatalogs((tx) => tx.db.select().from(platform).orderBy(asc(platform.id)));
}

/** El árbol de nichos, por slug. */
export async function listNiches(db: CatalogDb): Promise<Niche[]> {
  return db.withCatalogs((tx) => tx.db.select().from(niche).orderBy(asc(niche.slug)));
}

/** Los CPM de referencia por nicho, país y plataforma. Los usa Cotizar (COT-1). */
export async function listNicheCpmBenchmarks(db: CatalogDb): Promise<NicheCpmBenchmark[]> {
  return db.withCatalogs((tx) =>
    tx.db
      .select()
      .from(nicheCpmBenchmark)
      .orderBy(asc(nicheCpmBenchmark.nicheSlug), asc(nicheCpmBenchmark.country), asc(nicheCpmBenchmark.platform)),
  );
}

/**
 * Las etapas del embudo en orden. Sin `workspaceId` devuelve solo las
 * compartidas (workspace_id NULL); con él, las compartidas más las
 * propias de ese workspace. La tabla no tiene RLS a propósito
 * (catálogo con filas por workspace opcionales), así que el filtro es
 * explícito: es la excepción, y por eso se escribe una sola vez aquí.
 */
export async function listPipelineStages(db: CatalogDb, opts: { workspaceId?: string } = {}): Promise<PipelineStage[]> {
  const propias = opts.workspaceId
    ? or(isNull(pipelineStage.workspaceId), eq(pipelineStage.workspaceId, opts.workspaceId))
    : isNull(pipelineStage.workspaceId);
  return db.withCatalogs((tx) =>
    tx.db.select().from(pipelineStage).where(propias).orderBy(asc(pipelineStage.position)),
  );
}

/** Las fuentes de señales del radar de ventas, con sus términos de uso. */
export async function listSignalSources(db: CatalogDb): Promise<SignalSource[]> {
  return db.withCatalogs((tx) => tx.db.select().from(signalSource).orderBy(asc(signalSource.id)));
}

/**
 * Las banderas: las globales (workspace_id NULL) y, si se pide, las del
 * workspace. Mismo caso que pipeline_stage: catálogo sin RLS con filas
 * por workspace opcionales.
 */
export async function listFeatureFlags(db: CatalogDb, opts: { workspaceId?: string } = {}): Promise<FeatureFlag[]> {
  const propias = opts.workspaceId
    ? or(isNull(featureFlag.workspaceId), eq(featureFlag.workspaceId, opts.workspaceId))
    : isNull(featureFlag.workspaceId);
  return db.withCatalogs((tx) => tx.db.select().from(featureFlag).where(propias).orderBy(asc(featureFlag.key)));
}

/** Las definiciones de trabajos en segundo plano: cola, cron, timeout, reintentos. Agrupadas por cola. */
export async function listJobDefinitions(db: CatalogDb): Promise<JobDefinition[]> {
  return db.withCatalogs((tx) =>
    tx.db.select().from(jobDefinition).orderBy(asc(jobDefinition.queue), asc(jobDefinition.id)),
  );
}
