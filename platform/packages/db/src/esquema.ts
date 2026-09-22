/**
 * Qué esquema espera @mc/db, y cómo se comprueba contra la base a la
 * que acaba de conectarse.
 *
 * El contrato del paquete —«RLS filtra las lecturas: ninguna pantalla
 * pasa el workspace como parámetro»— no lo cumple el paquete: lo
 * cumplen las políticas que db/migrations dejó en la base. Si la base
 * está atrasada, todo compila, todas las rutas responden 200 y el
 * aislamiento simplemente no existe. Pasó: con 15 migraciones aplicadas
 * en Supabase y 19 en el repositorio, `relrowsecurity` era false en
 * outbound_policy, quote_item, rate_card_item, deal_stage_history,
 * campaign_post, membership y contact, y la web no decía nada.
 *
 * Por eso createDbFromEnv pregunta una vez, al construir el pool:
 *   - en desarrollo, un aviso con lo que falta y `make db.migrate`;
 *   - con NODE_ENV=production, lanza, con el mismo criterio que ya se
 *     aplica a DATABASE_URL.
 *
 * Dos comprobaciones, porque responden a cosas distintas:
 *   1. Migraciones aplicadas vs. db/migrations del repositorio. Es la
 *      pregunta directa, pero solo se puede hacer donde estén los
 *      archivos: el despliegue de Vercel excluye /db/migrations/ a
 *      propósito (.vercelignore), así que allí esta mitad se salta sola.
 *   2. Que las tablas que este paquete declara aisladas tengan RLS
 *      activo de verdad. No necesita los archivos, viaja con el bundle
 *      y es exactamente la promesa que se estaba rompiendo.
 */
import type { CatalogDb } from './client.ts';

/**
 * Tablas del MVP con workspace_id NOT NULL: toda fila pertenece a un
 * workspace y una política la aísla (0010, 0011, 0017, 0019).
 */
export const TABLAS_DE_TENANT = [
  'membership',
  'creator_profile', 'social_connection', 'data_consent', 'post', 'post_metric_snapshot',
  'account_metric_snapshot', 'audience_breakdown', 'creator_baseline', 'post_score', 'company_link',
  'signal', 'deal', 'activity', 'outbound_brief', 'outbound_policy', 'outbound_sequence', 'outbound_touch',
  'rate_card', 'media_kit', 'quote', 'campaign', 'campaign_result', 'invoice', 'payment', 'expense',
  'platform_payout', 'tax_reserve', 'notification', 'job_run',
] as const;

/**
 * Hijas de una tabla de tenant, sin workspace_id propio: heredan la
 * política del padre por EXISTS (0018). La FK al padre es NOT NULL.
 */
export const TABLAS_HIJAS: ReadonlyArray<readonly [child: string, parent: string]> = [
  ['quote_item', 'quote'],
  ['rate_card_item', 'rate_card'],
  ['deal_stage_history', 'deal'],
  ['campaign_post', 'campaign'],
  ['idea_evidence', 'idea'],
  ['posting_window', 'creator_profile'],
  ['script_block', 'script'],
  ['script_variant', 'script'],
  ['preflight_result', 'video_analysis'],
  ['preflight_verdict', 'video_analysis'],
  ['video_audio_profile', 'video_analysis'],
  ['video_feature', 'video_analysis'],
  ['video_onscreen_text', 'video_analysis'],
  ['video_prediction', 'video_analysis'],
  ['video_recommendation', 'video_analysis'],
  ['video_second', 'video_analysis'],
  ['video_shot', 'video_analysis'],
  ['video_transcript', 'video_analysis'],
  ['video_transcript_word', 'video_analysis'],
];

/**
 * Datos personales sin workspace_id, con política propia:
 *   contact   público, o del workspace que lo guardó (owner_workspace_id, 0020)
 *   app_user  yo, o quien comparte workspace conmigo (0020)
 */
export const TABLAS_PII = ['contact', 'app_user'] as const;

/**
 * Catálogos con workspace_id opcional (NULL = fila global). Desde 0020
 * llevan RLS: lo global se lee siempre, lo del workspace solo desde él,
 * y nadie escribe lo ajeno ni lo global desde una transacción de la
 * aplicación.
 */
export const CATALOGOS_CON_WORKSPACE = ['pipeline_stage', 'feature_flag'] as const;

/** Todas las tablas que TIENEN que tener relrowsecurity = true. */
export const TABLAS_CON_RLS: readonly string[] = [
  ...TABLAS_DE_TENANT,
  ...TABLAS_HIJAS.map(([child]) => child),
  ...TABLAS_PII,
  ...CATALOGOS_CON_WORKSPACE,
];

/** Lo que dice la base cuando se le pregunta por el esquema. */
export interface EstadoDelEsquema {
  /** Migraciones registradas en schema_migrations. -1 si la tabla no existe. */
  aplicadas: number;
  /** La última, por nombre de archivo. */
  ultima: string | null;
  /** Archivos de db/migrations que la base no tiene. Vacío si no se pudieron leer (ver arriba). */
  pendientes: string[];
  /** Tablas de TABLAS_CON_RLS que existen en la base SIN row level security. */
  sinRls: string[];
  /** Si la comprobación de archivos se pudo hacer. */
  comparadoConArchivos: boolean;
}

/**
 * Los nombres de db/migrations, o [] si no se pueden leer (el bundle de
 * Vercel no los lleva: .vercelignore excluye /db/migrations/).
 */
export async function migracionesDelRepositorio(): Promise<string[]> {
  try {
    const { listSql, MIGRATIONS_DIR } = await import('../../../db/lib/aplicar.mjs');
    return await listSql(MIGRATIONS_DIR);
  } catch {
    return [];
  }
}

interface FilaMigracion extends Record<string, unknown> {
  filename: string;
}
interface FilaRls extends Record<string, unknown> {
  relname: string;
}

/** Pregunta a la base qué migraciones tiene y qué tablas se quedaron sin RLS. */
export async function estadoDelEsquema(db: CatalogDb): Promise<EstadoDelEsquema> {
  const enElRepo = await migracionesDelRepositorio();
  const aplicadas = await db
    .withCatalogs((tx) => tx.query<FilaMigracion>('SELECT filename FROM schema_migrations ORDER BY filename'))
    .then((r) => r.rows.map((x) => x.filename))
    .catch(() => null); // la tabla no existe: base sin migrar

  const sinRls = await db
    .withCatalogs((tx) =>
      tx.query<FilaRls>(
        `SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND NOT c.relrowsecurity
            AND c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [[...TABLAS_CON_RLS]],
      ),
    )
    .then((r) => r.rows.map((x) => x.relname))
    .catch(() => [] as string[]);

  const tiene = new Set(aplicadas ?? []);
  return {
    aplicadas: aplicadas === null ? -1 : aplicadas.length,
    ultima: aplicadas && aplicadas.length ? (aplicadas[aplicadas.length - 1] ?? null) : null,
    pendientes: enElRepo.filter((f) => !tiene.has(f)),
    sinRls,
    comparadoConArchivos: enElRepo.length > 0 && aplicadas !== null,
  };
}

/** El texto del problema, o null si no hay ninguno. */
export function explicarEsquema(estado: EstadoDelEsquema): string | null {
  const partes: string[] = [];
  if (estado.aplicadas === -1) {
    partes.push('la base no tiene schema_migrations: nunca se migró');
  } else if (estado.pendientes.length) {
    partes.push(
      `faltan ${estado.pendientes.length} migración(es) por aplicar (la base va por ${estado.ultima ?? '—'}): ` +
        estado.pendientes.join(', '),
    );
  }
  if (estado.sinRls.length) {
    partes.push(
      `sin row level security, que es lo que aísla a cada workspace: ${estado.sinRls.join(', ')}. ` +
        'Mientras tanto esas tablas devuelven las filas de TODOS los workspaces',
    );
  }
  if (!partes.length) return null;
  return `[db] La base no tiene el esquema de este repositorio: ${partes.join('; ')}. Corre: make db.migrate`;
}

/**
 * ¿Un esquema atrasado impide arrancar?
 *
 * En producción sí: servir pantallas sin el aislamiento que el producto
 * promete es peor que no servirlas. La única salida es explícita y deja
 * rastro —ALLOW_STALE_SCHEMA=1—, para el despliegue que tiene que salir
 * antes de que el integrador corra `make db.migrate`; entonces el aviso
 * sale por stderr en cada arranque. Mismo patrón que
 * ALLOW_SEED_WORKSPACE en la web.
 */
export function esquemaObligatorio(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && env.ALLOW_STALE_SCHEMA !== '1';
}

/**
 * Comprueba el esquema una vez, al construir el cliente. En producción
 * lanza; en desarrollo avisa y sigue, que es lo que permite trabajar
 * contra una base a medio migrar sabiéndolo.
 */
export async function assertSchemaUpToDate(
  db: CatalogDb,
  opts: { production?: boolean; warn?: (message: string) => void } = {},
): Promise<EstadoDelEsquema> {
  const estado = await estadoDelEsquema(db);
  const problema = explicarEsquema(estado);
  if (problema) {
    if (opts.production) throw new Error(problema);
    // stderr y no console: ver la nota de createPool. La web pasa su
    // logger si quiere otra cosa.
    (opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`)))(problema);
  }
  return estado;
}
