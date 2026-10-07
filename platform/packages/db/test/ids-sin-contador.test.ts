/**
 * CIM-11 · Ninguna fila que mc_app lea lleva un contador global (0082).
 *
 * La actualización se prueba CON DATOS, como va a pasar en Supabase: una
 * base migrada hasta la migración anterior a 0082 (la forma vieja, con
 * `id bigserial`), los seeds del repositorio encima y una fila a mano en
 * cada tabla que los seeds dejan vacía, y entonces 0082. Lo que se mide:
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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSql, MIGRATIONS_DIR } from '../../../db/lib/aplicar.mjs';
import { applySeeds, createEmbeddedDb, SEED_DIR, type EmbeddedDb } from '../src/embedded.ts';
import { estadoDelEsquema, explicarEsquema } from '../src/esquema.ts';
import { SETUP_TIMEOUT, WORKSPACE_LAURA } from './pglite.ts';

/** Las quince tablas que tenían `id bigserial` (ver la cabecera de 0082). */
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
  -- Lo que deja auditAsJob: el número de la corrida dentro del JSON. Una
  -- como número (lo que escribía el código de antes de 0082), otra como
  -- texto, y una que nombra una corrida que no existe (se queda igual).
  INSERT INTO audit_log (workspace_id, actor_kind, action, entity_type, after)
  SELECT '${WORKSPACE_LAURA}', 'job', 'prueba.cim11.job.' || j.status, 'test',
         jsonb_build_object('source', 'api', '_job', jsonb_build_object('id', j.job_id,
           'runId', CASE WHEN j.status = 'ok' THEN to_jsonb(j.id) ELSE to_jsonb(j.id::text) END))
    FROM job_run j WHERE j.job_id = 'brand.snapshot';
  INSERT INTO audit_log (workspace_id, actor_kind, action, entity_type, after) VALUES
    ('${WORKSPACE_LAURA}', 'job', 'prueba.cim11.job.huerfana', 'test',
     '{"_job": {"id": "brand.snapshot", "runId": "987654321"}}');
  INSERT INTO api_call_log (connection_id, platform_id, endpoint, ok)
  SELECT id, platform_id, 'cim-11.prueba', true FROM social_connection ORDER BY id LIMIT 1;
`;

interface Huella extends Record<string, unknown> {
  tabla: string;
  filas: number;
  huella: string;
}

/**
 * Por tabla: cuántas filas y un md5 de todas ellas SIN el id (ni el step
 * que 0082 le añade a deal_stage_history, ni el runId que audit_log
 * guarda de job_run en after._job: los dos se miden aparte), en un orden
 * que no depende del id. Si la conversión perdiera, duplicara o tocara
 * una fila (una clave ajena incluida), la huella cambia.
 */
async function huellas(db: EmbeddedDb): Promise<Huella[]> {
  const sql = TABLAS.map(
    (t) =>
      `SELECT '${t}' AS tabla, count(*)::int AS filas,
              md5(coalesce(string_agg(f, '|' ORDER BY f), '')) AS huella
         FROM (SELECT ((to_jsonb(x) - 'id' - 'step') #- '{after,_job,runId}')::text AS f FROM public.${t} x) s`,
  ).join(' UNION ALL ');
  return (await db.queryAsSuperuser<Huella>(`${sql} ORDER BY tabla`)).rows;
}

/** La historia de los negocios con el número de cada paso (`orden` es la expresión SQL que lo da). */
async function pasos(db: EmbeddedDb, orden: string): Promise<string> {
  const { rows } = await db.queryAsSuperuser<{ pasos: string }>(
    `SELECT coalesce(string_agg(f, '|' ORDER BY f), '') AS pasos
       FROM (SELECT concat_ws(',', deal_id, from_stage_id, to_stage_id, changed_at, ${orden}) AS f
               FROM deal_stage_history) s`,
  );
  return rows[0]!.pasos;
}

interface CorridaDeLaBitacora extends Record<string, unknown> {
  action: string;
  corrida: string | null;
}

/**
 * Cada entrada de bitácora escrita por un job, con la corrida a la que
 * apunta su after._job.runId descrita por lo que no es el id (job, estado,
 * inicio). Antes y después de 0082 tiene que dar lo mismo: el runId cambia
 * de número a uuid, la corrida a la que apunta no.
 */
async function corridasDeLaBitacora(db: EmbeddedDb): Promise<CorridaDeLaBitacora[]> {
  const { rows } = await db.queryAsSuperuser<CorridaDeLaBitacora>(
    `SELECT a.action, concat_ws(',', j.job_id, j.status, j.started_at) AS corrida
       FROM audit_log a
       LEFT JOIN job_run j ON j.id::text = a.after -> '_job' ->> 'runId'
      WHERE a.after ? '_job'
      ORDER BY a.action`,
  );
  return rows.map((r) => ({ action: r.action, corrida: r.corrida === '' ? null : r.corrida }));
}

/** Lo que devuelve post_metrics_at_cut, entero, como huella. */
async function huellaDeLosCortes(db: EmbeddedDb): Promise<{ filas: number; huella: string }> {
  const { rows } = await db.queryAsSuperuser<{ filas: number; huella: string }>(
    `SELECT count(*)::int AS filas, md5(coalesce(string_agg(f, '|' ORDER BY f), '')) AS huella
       FROM (SELECT to_jsonb(v)::text AS f FROM post_metrics_at_cut v) s`,
  );
  return rows[0]!;
}

describe('0082 convierte las claves con las filas dentro', () => {
  let db: EmbeddedDb;
  let antes: Huella[];
  let cortesAntes: { filas: number; huella: string };
  let guardiaAntes: string[];
  let aplicadas: string[];
  let pasosAntes: string;
  let bitacoraAntes: CorridaDeLaBitacora[];

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
    pasosAntes = await pasos(db, 'row_number() OVER (PARTITION BY deal_id ORDER BY changed_at, id)');
    bitacoraAntes = await corridasDeLaBitacora(db);
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

  test('la bitácora de los jobs sigue apuntando a su corrida: after._job.runId pasa del número al uuid de la misma fila de job_run', async () => {
    // La prueba no es sobre una bitácora sin jobs: hay dos que apuntan a
    // una corrida (una con el runId como número, otra como texto) y una
    // huérfana desde antes.
    assert.deepEqual(
      bitacoraAntes.map((b) => [b.action, b.corrida !== null]),
      [['prueba.cim11.job.failed', true], ['prueba.cim11.job.huerfana', false], ['prueba.cim11.job.ok', true]],
    );
    assert.deepEqual(await corridasDeLaBitacora(db), bitacoraAntes);
    const { rows } = await db.queryAsSuperuser<{ action: string; run_id: string; existe: boolean }>(
      `SELECT a.action, a.after -> '_job' ->> 'runId' AS run_id,
              EXISTS (SELECT 1 FROM job_run j WHERE j.id::text = a.after -> '_job' ->> 'runId') AS existe
         FROM audit_log a WHERE a.action LIKE 'prueba.cim11.job.%' ORDER BY a.action`,
    );
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.deepEqual(
      rows.map((r) => [r.action, r.existe, UUID.test(r.run_id)]),
      [['prueba.cim11.job.failed', true, true], ['prueba.cim11.job.huerfana', false, false], ['prueba.cim11.job.ok', true, true]],
    );
    // La huérfana no se toca, y job_run no se lleva la columna de paso.
    assert.equal(rows.find((r) => r.action === 'prueba.cim11.job.huerfana')!.run_id, '987654321');
    const columna = await db.queryAsSuperuser(
      "SELECT 1 FROM pg_attribute WHERE attrelid = 'public.job_run'::regclass AND attname = 'id_nuevo' AND NOT attisdropped",
    );
    assert.equal(columna.rows.length, 0);
  });

  test('deal_stage_history.step numera los pasos de cada negocio en el orden que daba el id', async () => {
    assert.equal(await pasos(db, 'step'), pasosAntes);
    // Y el siguiente paso de un negocio lo numera la base, aunque se pida otro.
    const { rows } = await db.queryAsSuperuser<{ deal_id: string; max: number }>(
      'SELECT deal_id, max(step)::int AS max FROM deal_stage_history GROUP BY deal_id ORDER BY deal_id LIMIT 1',
    );
    const { deal_id, max } = rows[0]!;
    const nuevo = await db.queryAsSuperuser<{ step: number }>(
      `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, step)
       SELECT id, stage_id, stage_id, 1 FROM deal WHERE id = $1 RETURNING step`,
      [deal_id],
    );
    assert.equal(nuevo.rows[0]!.step, max + 1);
    await db.execAsSuperuser(`DELETE FROM deal_stage_history WHERE deal_id = '${deal_id}' AND step = ${max + 1}`);
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

  test('como mc_app, el INSERT devuelve un uuid, y la fecha de dos entradas de la misma transacción es la del reloj', async () => {
    const r = await db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const alta = (n: number) =>
        tx.query<{ id: string; created_at: string; inicio: string }>(
          `INSERT INTO audit_log (workspace_id, action, entity_type)
           VALUES (current_workspace_id(), 'prueba.cim11.orden.${n}', 'test')
           RETURNING id::text AS id, created_at::text AS created_at, now()::text AS inicio`,
        );
      const uno = (await alta(1)).rows[0]!;
      // Más que el milisegundo del reloj de PGlite: así la diferencia se ve.
      await tx.query('SELECT pg_sleep(0.005)');
      const dos = (await alta(2)).rows[0]!;
      return { uno, dos };
    });
    assert.match(r.uno.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(r.uno.id, r.dos.id);
    // now() es el mismo para toda la transacción; clock_timestamp() no.
    assert.equal(r.uno.inicio, r.dos.inicio);
    assert.ok(new Date(r.dos.created_at) > new Date(r.uno.created_at), `${r.uno.created_at} → ${r.dos.created_at}`);
    const { rows } = await db.queryAsSuperuser<{ col: string; def: string }>(
      `SELECT c.relname || '.' || a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE (c.relname, a.attname) IN (('api_call_log', 'called_at'), ('audit_log', 'created_at'), ('job_run', 'started_at'))
        ORDER BY 1`,
    );
    assert.deepEqual(rows, [
      { col: 'api_call_log.called_at', def: 'clock_timestamp()' },
      { col: 'audit_log.created_at', def: 'clock_timestamp()' },
      { col: 'job_run.started_at', def: 'clock_timestamp()' },
    ]);
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
      const explicacion = explicarEsquema(e) ?? '';
      assert.match(explicacion, /secuencia[\s\S]*zz_cim11_contador\.id[\s\S]*CLAVES_DE_SECUENCIA_DECLARADAS/);
      // Dice los dos roles y los cuatro caminos que mira, no solo un GRANT
      // directo a mc_app (zz_cim11_del_enlace solo le llega a mc_public_share).
      assert.match(explicacion, /tablas que mc_app o mc_public_share leen o escriben \(directo, por PUBLIC, por membresía o por columna\)/);
    } finally {
      await db.execAsSuperuser('DROP TABLE zz_cim11_contador, zz_cim11_identidad, zz_cim11_del_worker');
    }
  });

  test('la guardia y la comprobación final de 0082 §5 frenan un DEFAULT que llama a nextval dentro de una expresión', async () => {
    // Un folio como 'Q-' || nextval(…) es el mismo contador con otro
    // disfraz: el DEFAULT no EMPIEZA por nextval, pero lo lleva. La
    // guardia y §5 tienen que decir lo mismo; §5 se lee del archivo de la
    // migración (desde su encabezado hasta el final) y se ejecuta tal cual.
    const archivos = await listSql(MIGRATIONS_DIR);
    const nombre = archivos.find((f) => f.endsWith('_ids_sin_contador.sql'))!;
    const migracion = await readFile(join(MIGRATIONS_DIR, nombre), 'utf8');
    const inicio = migracion.indexOf('-- 5 · Comprobación');
    assert.ok(inicio > 0, 'falta §5 en la migración');
    const comprobacion = migracion.slice(inicio);
    await db.execAsSuperuser(comprobacion); // sin la tabla nueva, pasa

    await db.execAsSuperuser(
      `SET ROLE ${MIGRADOR};
       CREATE SEQUENCE zz_cim11_folio_seq;
       CREATE TABLE zz_cim11_folio (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         folio text NOT NULL DEFAULT ('Q-' || nextval('zz_cim11_folio_seq')::text)
       );
       REVOKE ALL ON zz_cim11_folio FROM mc_app, mc_public_share, PUBLIC;
       GRANT SELECT ON zz_cim11_folio TO mc_app;
       RESET ROLE`,
    );
    try {
      const { rows } = await db.queryAsSuperuser<{ def: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS def
           FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'zz_cim11_folio'::regclass AND a.attname = 'folio'`,
      );
      const def = rows[0]!.def;
      assert.doesNotMatch(def, /^nextval\(/, `el DEFAULT no empieza por nextval: ${def}`);
      const e = await estadoDelEsquema(db);
      assert.deepEqual(e.clavesDeSecuencia, [`zz_cim11_folio.folio (${def})`]);
      await assert.rejects(
        db.execAsSuperuser(comprobacion),
        /quedan claves de secuencia global donde llegan mc_app o mc_public_share: zz_cim11_folio\.folio/,
      );
    } finally {
      await db.execAsSuperuser('DROP TABLE zz_cim11_folio; DROP SEQUENCE zz_cim11_folio_seq');
    }
  });

  test('outreach_writer_status y outreach_classifier_status: a igual started_at, manda la corrida que terminó después (0082 §4b)', async () => {
    const casos = [
      { job: 'outbound.generate', fn: 'outreach_writer_status', clave: 'writer', antes: 'fake', despues: 'anthropic' },
      { job: 'outbound.intent', fn: 'outreach_classifier_status', clave: 'classifier', antes: 'fake', despues: 'model' },
    ];
    for (const c of casos) {
      for (const [primero, segundo] of [[c.antes, c.despues], [c.despues, c.antes]] as const) {
        await db.execAsSuperuser(`DELETE FROM job_run WHERE job_id = '${c.job}'`);
        // El mismo started_at; la que terminó después se inserta primero,
        // para que el orden de llegada no la favorezca.
        await db.execAsSuperuser(
          `INSERT INTO job_run (job_id, status, attempt, started_at, finished_at, metadata) VALUES
             ('${c.job}', 'ok', 1, date_trunc('minute', now()) - interval '1 hour', date_trunc('minute', now()) - interval '50 minutes', '{"${c.clave}": "${segundo}"}'),
             ('${c.job}', 'ok', 1, date_trunc('minute', now()) - interval '1 hour', date_trunc('minute', now()) - interval '55 minutes', '{"${c.clave}": "${primero}"}')`,
        );
        const { rows } = await db.queryAsSuperuser<{ s: string }>(`SELECT ${c.fn}() AS s`);
        assert.equal(rows[0]!.s, segundo, `${c.fn}: la que terminó después es la última`);
      }
      await db.execAsSuperuser(`DELETE FROM job_run WHERE job_id = '${c.job}'`);
    }
  });

  test('la guardia también ve la secuencia que le llega a mc_app por un rol intermedio, por columna, o a mc_public_share', async () => {
    // El mismo criterio que la comprobación final de 0082 §5
    // (has_any_column_privilege): un GRANT directo a mc_app no es el
    // único camino por el que el id de una fila llega a quien no debe.
    await db.execAsSuperuser(
      `CREATE ROLE zz_cim11_intermedio NOLOGIN;
       GRANT zz_cim11_intermedio TO mc_app;
       SET ROLE ${MIGRADOR};
       CREATE TABLE zz_cim11_heredada (id bigserial PRIMARY KEY);
       CREATE TABLE zz_cim11_por_columna (id bigserial PRIMARY KEY, nota text);
       CREATE TABLE zz_cim11_del_enlace (id bigserial PRIMARY KEY);
       CREATE TABLE zz_cim11_de_nadie (id bigserial PRIMARY KEY);
       REVOKE ALL ON zz_cim11_heredada, zz_cim11_por_columna, zz_cim11_del_enlace, zz_cim11_de_nadie FROM mc_app, mc_public_share, PUBLIC;
       GRANT SELECT ON zz_cim11_heredada TO zz_cim11_intermedio;
       GRANT SELECT (nota) ON zz_cim11_por_columna TO mc_app;
       GRANT INSERT ON zz_cim11_del_enlace TO mc_public_share;
       RESET ROLE`,
    );
    try {
      const e = await estadoDelEsquema(db);
      assert.deepEqual(e.clavesDeSecuencia, [
        'zz_cim11_del_enlace.id (public.zz_cim11_del_enlace_id_seq)',
        'zz_cim11_heredada.id (public.zz_cim11_heredada_id_seq)',
        'zz_cim11_por_columna.id (public.zz_cim11_por_columna_id_seq)',
      ]);
      assert.match(explicarEsquema(e) ?? '', /mc_app o mc_public_share leen o escriben[\s\S]*zz_cim11_del_enlace\.id/);
    } finally {
      await db.execAsSuperuser(
        `DROP TABLE zz_cim11_heredada, zz_cim11_por_columna, zz_cim11_del_enlace, zz_cim11_de_nadie;
         REVOKE zz_cim11_intermedio FROM mc_app;
         DROP ROLE zz_cim11_intermedio`,
      );
    }
  });
});
