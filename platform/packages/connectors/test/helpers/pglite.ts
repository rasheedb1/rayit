/**
 * Postgres embebido con las migraciones reales del repo, para las pruebas de persistencia.
 *
 * Las aplica db/lib/aplicar.mjs, el mismo runner de @mc/db, del worker y
 * de `make db.migrate` (CON-2b). Se importa por ruta y no por @mc/db
 * porque @mc/db ya depende de @mc/connectors: el paquete no puede
 * depender de vuelta.
 */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { applyMigrations, MIGRATIONS_DIR, type MigrationExec } from '../../../../db/lib/aplicar.mjs';
import type { SqlExecutor } from '../../src/log/postgres.ts';

export { MIGRATIONS_DIR };

export const WORKSPACE_ID = '00000002-0000-4000-8000-000000000001';
export const CREATOR_ID = '00000002-0000-4000-8000-000000000003';
export const CONNECTION_TIKTOK = '00000002-0000-4000-8000-0000000000c2';
export const CONNECTION_YOUTUBE = '00000002-0000-4000-8000-0000000000c3';

export async function openMigratedPglite(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { citext, pg_trgm } });
  const exec: MigrationExec = async (sql) => {
    const out = await db.exec(sql);
    return { rows: (out.at(-1)?.rows ?? []) as Array<Record<string, unknown>> };
  };
  await applyMigrations(exec, { dir: MIGRATIONS_DIR });
  return db;
}

/** Workspace, creadora y dos conexiones con los ids fijos del seed 0003 (sección 0). */
export async function seedConnections(db: PGlite): Promise<void> {
  await db.exec(`
    SELECT set_config('app.workspace_id', '${WORKSPACE_ID}', false);
    INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan)
      VALUES ('${WORKSPACE_ID}', 'laura-cocina-facil', 'Laura', 'creator', 'CO', 'COP', 'America/Bogota', 'es-CO', 'creator');
    INSERT INTO app_user (id, email, name, locale) VALUES ('00000002-0000-4000-8000-000000000002', 'laura@ejemplo.com', 'Laura', 'es-CO');
    INSERT INTO creator_profile (id, workspace_id, user_id, display_name, handle)
      VALUES ('${CREATOR_ID}', '${WORKSPACE_ID}', '00000002-0000-4000-8000-000000000002', 'Laura', 'laura.cocinafacil');
    INSERT INTO social_connection (id, workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes)
      VALUES ('${CONNECTION_TIKTOK}', '${WORKSPACE_ID}', '${CREATOR_ID}', 'tiktok', 'open_id_demo_laura', 'laura.cocinafacil', 'vault://demo/tiktok/laura', '{video.list}'),
             ('${CONNECTION_YOUTUBE}', '${WORKSPACE_ID}', '${CREATOR_ID}', 'youtube', 'UCdemo000000000000000001', 'LauraCocinaFacil', 'vault://demo/youtube/laura', '{youtube.readonly}');
  `);
}

export function executor(db: PGlite): SqlExecutor {
  return { query: (text, params = []) => db.query(text, params as unknown[]) };
}
