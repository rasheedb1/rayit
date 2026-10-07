/**
 * CIM-11 · Ninguna fila que mc_app lea lleva un contador global (0078).
 *
 * La actualización se prueba CON DATOS, como va a pasar en Supabase: una
 * base migrada hasta la migración anterior a 0078 (la forma vieja, con
 * `id bigserial`), los seeds del repositorio encima y una fila a mano en
 * cada tabla que los seeds dejan vacía, y entonces 0078. Lo que se mide:
 *
 *   - ninguna fila se pierde ni cambia: por tabla, el mismo número de
 *     filas y la misma huella de todo lo que no es el id (las claves
 *     ajenas incluidas, así que las referencias quedan intactas);
 *   - cada id es ahora un uuid único, con DEFAULT gen_random_uuid(), y
 *     ninguna secuencia queda en `public`;
 *   - post_metrics_at_cut devuelve lo mismo (su desempate ya no usa el id);
 *   - como mc_app, el id que devuelve un INSERT es un uuid, y dos
 *     entradas de la misma transacción quedan ordenadas por su fecha;
 *   - la guardia nombraba las quince antes y ninguna después, y nombra la
 *     próxima tabla que nazca con una secuencia a la vista de mc_app.
 *
 * Sin red: Postgres embebido (PGlite), el mismo runner que Supabase.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { listSql, MIGRATIONS_DIR } from '../../../db/lib/aplicar.mjs';
import { applySeeds, createEmbeddedDb, SEED_DIR, type EmbeddedDb } from '../src/embedded.ts';
import { estadoDelEsquema, explicarEsquema } from '../src/esquema.ts';
import { SETUP_TIMEOUT, WORKSPACE_LAURA } from './pglite.ts';

/** Las quince tablas que tenían `id bigserial` (ver la cabecera de 0078). */
const TABLAS = [
  'account_metric_snapshot', 'api_call_log', 'api_quota_usage', 'audit_log', 'brand_account_snapshot',
  'deal_stage_history', 'external_post_snapshot', 'idea_evidence', 'job_run', 'post_engagement_curve',
  'post_impression_source', 'post_metric_snapshot', 'post_retention_curve', 'preflight_result',
  'video_onscreen_text',
] as const;

const MIGRADOR = 'mc_migrator_embedded';

/**
 * Una fila en cada tabla que los seeds dejan vacía, colgada de filas
 * reales de los seeds (un post, un análisis de video, una definición de
 * job), para que la conversión tenga referencias que conservar. Va como
 * superusuario: es preparar la base, no probar la RLS.
 */
const SEMBRAR_LAS_VACIAS = `
  WITH p AS (SELECT id, workspace_id, creator_id FROM post ORDER BY id LIMIT 1),
       i AS (INSERT INTO idea (workspace_id, creator_id, title)
             SELECT workspace_id, creator_id, 'Idea de la prueba de CIM-11' FROM p RETURNING id)
  INSERT INTO idea_evidence (idea_id, source, text_es, ref_post_id)
  SELECT i.id, 'internal', 'Evidencia de la prueba de CIM-11', p.id FROM i, p;

  WITH e AS (INSERT INTO external_post (platform_id, external_post_id) VALUES ('tiktok', 'cim-11-externo') RETURNING id)
  INSERT INTO external_post_snapshot (external_post_id, age_hours, views) SELECT id, 24, 1000 FROM e;

  INSERT INTO preflight_result (analysis_id, rule_id, outcome)
  SELECT v.id, r.id, 'pass' FROM (SELECT id FROM video_analysis ORDER BY id LIMIT 1) v, (SELECT id FROM preflight_rule ORDER BY id LIMIT 1) r;
  INSERT INTO video_onscreen_text (analysis_id, text, start_s, end_s)
  SELECT id, 'texto en pantalla', 0, 2.5 FROM video_analysis ORDER BY id LIMIT 1;

  INSERT INTO post_engagement_curve (post_id, workspace_id, curve)
  SELECT id, workspace_id, '[1, 2, 3]'::jsonb FROM post ORDER BY id LIMIT 1;
  INSERT INTO post_impression_source (post_id, workspace_id, source_name, share)
  SELECT id, workspace_id, 'for_you', 0.8 FROM post ORDER BY id LIMIT 1;
  INSERT INTO post_retention_curve (post_id, workspace_id, age_hours, curve, seconds_count)
  SELECT id, workspace_id, 24, '[1, 0.8, 0.6]'::jsonb, 3 FROM post ORDER BY id LIMIT 1;

  INSERT INTO api_quota_usage (platform_id, day, units_used) VALUES ('tiktok', DATE '2026-10-01', 7);
  INSERT INTO job_run (job_id, status, started_at) VALUES
    ('brand.snapshot', 'ok', TIMESTAMPTZ '2026-10-01 07:00:00+00'),
    ('brand.snapshot', 'failed', TIMESTAMPTZ '2026-10-02 07:00:00+00');
  INSERT INTO audit_log (workspace_id, action, entity_type) VALUES
    ('${WORKSPACE_LAURA}', 'prueba.cim11.uno', 'test'),
    ('${WORKSPACE_LAURA}', 'prueba.cim11.dos', 'test');
  INSERT INTO api_call_log (connection_id, platform_id, endpoint, ok)
  SELECT id, platform_id, 'cim-11.prueba', true FROM social_connection ORDER BY id LIMIT 1;
`;

interface Huella extends Record<string, unknown> {
  tabla: string;
  filas: number;
  huella: string;
}

/**
 * Por tabla: cuántas filas y un md5 de todas ellas SIN el id, en un orden
 * que no depende del id. Si la conversión perdiera, duplicara o tocara
 * una fila (una clave ajena incluida), la huella cambia.
 */
async function huellas(db: EmbeddedDb): Promise<Huella[]> {
  const sql = TABLAS.map(
    (t) =>
      `SELECT '${t}' AS tabla, count(*)::int AS filas,
              md5(coalesce(string_agg(f, '|' ORDER BY f), '')) AS huella
         FROM (SELECT (to_jsonb(x) - 'id')::text AS f FROM public.${t} x) s`,
  ).join(' UNION ALL ');
  return (await db.queryAsSuperuser<Huella>(`${sql} ORDER BY tabla`)).rows;
}

/** Lo que devuelve post_metrics_at_cut, entero, como huella. */
async function huellaDeLosCortes(db: EmbeddedDb): Promise<{ filas: number; huella: string }> {
  const { rows } = await db.queryAsSuperuser<{ filas: number; huella: string }>(
    `SELECT count(*)::int AS filas, md5(coalesce(string_agg(f, '|' ORDER BY f), '')) AS huella
       FROM (SELECT to_jsonb(v)::text AS f FROM post_metrics_at_cut v) s`,
  );
  return rows[0]!;
}

describe('0078 convierte las claves con las filas dentro', () => {
  let db: EmbeddedDb;
  let antes: Huella[];
  let cortesAntes: { filas: number; huella: string };
  let guardiaAntes: string[];
  let aplicadas: string[];

  before(async () => {
    // La migración por su nombre, no por su número: si el integrador la
    // renumera, la prueba sigue migrando hasta la anterior.
    const archivos = await listSql(MIGRATIONS_DIR);
    const i = archivos.findIndex((f) => f.endsWith('_ids_sin_contador.sql'));
    assert.ok(i > 0, 'falta la migración *_ids_sin_contador.sql');
    db = await createEmbeddedDb({ hasta: archivos[i - 1] });
    // Los seeds, con el mismo runner y el mismo rol que en una base completa
    // (createEmbeddedDb no los carga con `hasta`): cada uno en su transacción.
    await applySeeds((sql) => db.execAsSuperuser(`SET ROLE ${MIGRADOR}; ${sql}`).then(() => ({ rows: [] })), { dir: SEED_DIR });
    await db.execAsSuperuser(SEMBRAR_LAS_VACIAS);
    antes = await huellas(db);
    cortesAntes = await huellaDeLosCortes(db);
    guardiaAntes = (await estadoDelEsquema(db)).clavesDeSecuencia;
    aplicadas = await db.migrar();
  }, SETUP_TIMEOUT);
  after(() => db?.close());

  test('se aplica la migración de CIM-11 y nada más', () => {
    assert.equal(aplicadas.length, 1, JSON.stringify(aplicadas));
    assert.match(aplicadas[0]!, /_ids_sin_contador\.sql$/);
  });

  test('antes de convertir, cada tabla tenía filas (la prueba no es sobre tablas vacías)', () => {
    assert.deepEqual(antes.filter((h) => h.filas === 0).map((h) => h.tabla), []);
    // Los seeds traen miles de lecturas: la conversión se prueba a escala.
    assert.ok(antes.find((h) => h.tabla === 'post_metric_snapshot')!.filas > 1000);
  });

  test('ninguna fila se pierde ni cambia: mismas filas y misma huella sin el id, tabla por tabla', async () => {
    assert.deepEqual(await huellas(db), antes);
  });

  test('cada id es un uuid único con DEFAULT gen_random_uuid(), sigue siendo la clave primaria, y no queda ninguna secuencia', async () => {
    const { rows } = await db.queryAsSuperuser<{ tabla: string; tipo: string; def: string | null; pk: boolean }>(
      `SELECT c.relname AS tabla, format_type(a.atttypid, a.atttypmod) AS tipo, pg_get_expr(d.adbin, d.adrelid) AS def,
              EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p'
                         AND k.conkey = ARRAY[a.attnum] AND k.conname = c.relname || '_pkey') AS pk
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id'
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
        ORDER BY 1`,
      [TABLAS],
    );
    assert.deepEqual(
      rows.map((r) => [r.tabla, r.tipo, r.def, r.pk]),
      TABLAS.map((t) => [t, 'uuid', 'gen_random_uuid()', true]),
    );
    const distintos = await db.queryAsSuperuser<{ tabla: string; filas: number; ids: number }>(
      TABLAS.map((t) => `SELECT '${t}' AS tabla, count(*)::int AS filas, count(DISTINCT id)::int AS ids FROM public.${t}`).join(' UNION ALL '),
    );
    for (const r of distintos.rows) assert.equal(r.ids, r.filas, `${r.tabla}: ids repetidos o nulos`);
    const secuencias = await db.queryAsSuperuser<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relkind = 'S' AND relnamespace = 'public'::regnamespace",
    );
    assert.deepEqual(secuencias.rows, []);
  });

  test('las referencias siguen apuntando: ninguna hija queda sin su padre', async () => {
    const { rows } = await db.queryAsSuperuser<{ huerfanas: number }>(
      `SELECT ((SELECT count(*) FROM idea_evidence e LEFT JOIN idea i ON i.id = e.idea_id WHERE i.id IS NULL)
             + (SELECT count(*) FROM post_metric_snapshot s LEFT JOIN post p ON p.id = s.post_id WHERE p.id IS NULL)
             + (SELECT count(*) FROM deal_stage_history h LEFT JOIN deal d ON d.id = h.deal_id WHERE d.id IS NULL)
             + (SELECT count(*) FROM external_post_snapshot s LEFT JOIN external_post e ON e.id = s.external_post_id WHERE e.id IS NULL)
             + (SELECT count(*) FROM preflight_result r LEFT JOIN video_analysis v ON v.id = r.analysis_id WHERE v.id IS NULL))::int
            AS huerfanas`,
    );
    assert.equal(rows[0]!.huerfanas, 0);
  });

  test('post_metrics_at_cut devuelve las mismas lecturas que antes', async () => {
    assert.deepEqual(await huellaDeLosCortes(db), cortesAntes);
  });

  test('la guardia nombraba las quince antes de convertir, y ninguna después', async () => {
    assert.deepEqual(
      guardiaAntes.map((c) => c.slice(0, c.indexOf(' '))),
      TABLAS.map((t) => `${t}.id`),
    );
    const despues = await estadoDelEsquema(db);
    assert.deepEqual(despues.clavesDeSecuencia, []);
    assert.equal(explicarEsquema(despues), null);
  });

  test('como mc_app, el INSERT devuelve un uuid, y dos entradas de la misma transacción quedan en orden por su fecha', async () => {
    const r = await db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const alta = (n: number) =>
        tx.query<{ id: string }>(
          `INSERT INTO audit_log (workspace_id, action, entity_type)
           VALUES (current_workspace_id(), 'prueba.cim11.orden.${n}', 'test') RETURNING id::text AS id`,
        );
      const uno = await alta(1);
      const dos = await alta(2);
      const orden = await tx.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE action LIKE 'prueba.cim11.orden.%' ORDER BY created_at",
      );
      return { uno: uno.rows[0]!.id, dos: dos.rows[0]!.id, orden: orden.rows.map((x) => x.action) };
    });
    assert.match(r.uno, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(r.uno, r.dos);
    assert.deepEqual(r.orden, ['prueba.cim11.orden.1', 'prueba.cim11.orden.2']);
  });

  test('la guardia nombra la próxima tabla que nazca con una secuencia a la vista de mc_app', async () => {
    await db.execAsSuperuser(
      `SET ROLE ${MIGRADOR};
       CREATE TABLE zz_cim11_contador (id bigserial PRIMARY KEY, nota text);
       CREATE TABLE zz_cim11_identidad (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero bigint GENERATED ALWAYS AS IDENTITY);
       CREATE TABLE zz_cim11_del_worker (id bigserial PRIMARY KEY);
       REVOKE ALL ON zz_cim11_contador, zz_cim11_identidad, zz_cim11_del_worker FROM mc_app;
       GRANT INSERT ON zz_cim11_contador TO mc_app;
       GRANT SELECT ON zz_cim11_identidad TO mc_app;
       RESET ROLE`,
    );
    try {
      const e = await estadoDelEsquema(db);
      assert.deepEqual(e.clavesDeSecuencia, [
        'zz_cim11_contador.id (public.zz_cim11_contador_id_seq)',
        'zz_cim11_identidad.numero (public.zz_cim11_identidad_numero_seq)',
      ]);
      assert.match(explicarEsquema(e) ?? '', /secuencia[\s\S]*zz_cim11_contador\.id[\s\S]*CLAVES_DE_SECUENCIA_DECLARADAS/);
    } finally {
      await db.execAsSuperuser('DROP TABLE zz_cim11_contador, zz_cim11_identidad, zz_cim11_del_worker');
    }
  });
});
