/**
 * Los catálogos del producto: las tablas que se leen ANTES de que haya
 * un workspace fijado. Dueño: CIM (cimientos).
 *
 * Son siete y están aquí con nombre a propósito. El cliente sabe abrir
 * una transacción sin workspace (`withCatalogs`), pero esa puerta no
 * sale del barril de `@mc/db`: sobre una tabla con RLS devuelve cero
 * filas en silencio, y quien la use por descuido verá una lista vacía y
 * buscará el error en la pantalla. Pedir un catálogo por su nombre no
 * tiene esa trampa.
 *
 * Dos de ellos —`pipeline_stage` y `feature_flag`— tienen filas
 * globales (workspace_id NULL) y filas de un workspace. Hasta la ronda
 * 4 no llevaban RLS y el filtro se hacía aquí, con el workspace como
 * parámetro suelto: quien llamaba podía pasar el id de otro tenant y
 * leía sus etapas, o encenderle una bandera. Desde la migración 0020
 * llevan política y el parámetro desapareció: se pasa la transacción,
 * y quien decide qué filas hay es la base.
 *
 *   listPipelineStages(db)   → solo las globales (sin workspace fijado)
 *   listPipelineStages(tx)   → las globales más las de ESE workspace
 *
 * `company` y `contact` NO son catálogos aunque `company` no tenga
 * workspace_id: la relación con un workspace vive en `company_link`, y
 * `contact` lleva RLS propia desde 0019, con dueño desde 0020 (PII). Se
 * leen dentro de `withWorkspace`.
 */
import { asc } from 'drizzle-orm';
import type { BaseTx, CatalogDb, WorkspaceTx } from '../client.ts';
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

/**
 * Corre `fn` en la transacción que ya se tiene (WorkspaceTx) o abre una
 * de catálogos. Es lo que permite la misma consulta con y sin
 * workspace: la política de 0020 decide qué filas devuelve cada una.
 */
function conCatalogos<T>(fuente: CatalogDb | WorkspaceTx, fn: (tx: BaseTx) => Promise<T>): Promise<T> {
  return 'withCatalogs' in fuente ? fuente.withCatalogs(fn) : fn(fuente);
}

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
 * Las etapas del embudo en orden, solo las compartidas (workspace_id
 * NULL). Las de un workspace se leen con la otra firma, desde su
 * transacción.
 */
export async function listPipelineStages(db: CatalogDb): Promise<PipelineStage[]>;
/** Las compartidas más las de ESTE workspace. El filtro lo pone la base (RLS, migración 0020). */
export async function listPipelineStages(tx: WorkspaceTx): Promise<PipelineStage[]>;
export async function listPipelineStages(fuente: CatalogDb | WorkspaceTx): Promise<PipelineStage[]> {
  return conCatalogos(fuente, (tx) =>
    tx.db.select().from(pipelineStage).orderBy(asc(pipelineStage.position)),
  );
}

/** Las fuentes de señales del radar de ventas, con sus términos de uso. */
export async function listSignalSources(db: CatalogDb): Promise<SignalSource[]> {
  return db.withCatalogs((tx) => tx.db.select().from(signalSource).orderBy(asc(signalSource.id)));
}

/**
 * Las banderas. Mismo trato que pipeline_stage: con un CatalogDb, las
 * globales; con la transacción de un workspace, las globales más las
 * suyas.
 */
export async function listFeatureFlags(db: CatalogDb): Promise<FeatureFlag[]>;
export async function listFeatureFlags(tx: WorkspaceTx): Promise<FeatureFlag[]>;
export async function listFeatureFlags(fuente: CatalogDb | WorkspaceTx): Promise<FeatureFlag[]> {
  return conCatalogos(fuente, (tx) => tx.db.select().from(featureFlag).orderBy(asc(featureFlag.key)));
}

/** Las definiciones de trabajos en segundo plano: cola, cron, timeout, reintentos. Agrupadas por cola. */
export async function listJobDefinitions(db: CatalogDb): Promise<JobDefinition[]> {
  return db.withCatalogs((tx) =>
    tx.db.select().from(jobDefinition).orderBy(asc(jobDefinition.queue), asc(jobDefinition.id)),
  );
}
