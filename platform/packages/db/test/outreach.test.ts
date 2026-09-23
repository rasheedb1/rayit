/**
 * VEN-9 · la migración de outreach (0037) en Postgres embebido.
 *
 *   · los catálogos que trae: seis ángulos, la rúbrica por defecto y la
 *     plantilla «Marca con campaña activa»;
 *   · increment_if_under_cap e increment_weekly: dos llamadas a la vez con
 *     una plaza libre dan un true y un false, nunca dos true;
 *   · public_optout: la baja desde el enlace cruza workspaces, anota la
 *     supresión global y no deja nada pendiente; el token que no salió, o
 *     uno inventado, no encuentra nada;
 *   · el interruptor (disable/enable/should_pause), la salud y los días
 *     hábiles.
 *
 * Sin red y sin seeds: cada escenario se siembra como superusuario
 * (admin) y se ejercita con el rol de verdad (mc_app en withWorkspace o
 * withPublicShare, mc_worker en asWorker).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OUTREACH_FUNCTIONS } from '../src/schema/outreach.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const WS_A = '00000037-0000-4000-8000-00000000000a';
const WS_B = '00000037-0000-4000-8000-00000000000b';
const COMPANY = '00000037-0000-4000-8000-0000000000c1';
const CONTACT_A = '00000037-0000-4000-8000-0000000000a1';
const CONTACT_B = '00000037-0000-4000-8000-0000000000b1';
const CONTACT_OTRO = '00000037-0000-4000-8000-0000000000a2';
const SEQ_A = '00000037-0000-4000-8000-0000000005a1';
const SEQ_B = '00000037-0000-4000-8000-0000000005b1';
const STEP_A1 = '00000037-0000-4000-8000-0000000051a1';
const STEP_A2 = '00000037-0000-4000-8000-0000000051a2';
const STEP_B1 = '00000037-0000-4000-8000-0000000051b1';
const ENR_A = '00000037-0000-4000-8000-00000000e0a1';
const ENR_B = '00000037-0000-4000-8000-00000000e0b1';
const TOUCH_SENT = '00000037-0000-4000-8000-0000000070a1';
const TOUCH_PENDING_A = '00000037-0000-4000-8000-0000000070a2';
const TOUCH_PENDING_B = '00000037-0000-4000-8000-0000000070b1';
const TOUCH_OTRO = '00000037-0000-4000-8000-0000000070a3';

const TOKEN = 'k2Jd8sQ0pX4vN7bW1eR5tY9uI3oP6aS0';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  // Dos workspaces que escriben a la MISMA persona (mismo correo, dos
  // fichas), y un tercer contacto de A que no tiene nada que ver.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS_A}', 'outreach-a', 'Outreach A', 'America/Bogota'),
      ('${WS_B}', 'outreach-b', 'Outreach B', 'Europe/Madrid');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY}', 'Café de prueba', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${COMPANY}'), ('${WS_B}', '${COMPANY}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${CONTACT_A}', '${COMPANY}', 'Marta Marca', 'marta@cafe.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_B}', '${COMPANY}', 'Marta M.', 'MARTA@cafe.test', 'user_provided', '${WS_B}'),
      ('${CONTACT_OTRO}', '${COMPANY}', 'Otra persona', 'otra@cafe.test', 'user_provided', '${WS_A}');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES
      ('${SEQ_A}', '${WS_A}', 'Secuencia A', 'email', 'active'),
      ('${SEQ_B}', '${WS_B}', 'Secuencia B', 'email', 'active');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, step_type, channel, generate_with_ai, body_template) VALUES
      ('${STEP_A1}', '${WS_A}', '${SEQ_A}', 1, 'email', 'email', false, 'Hola'),
      ('${STEP_A2}', '${WS_A}', '${SEQ_A}', 5, 'email_reply', 'email', false, 'Sigo'),
      ('${STEP_B1}', '${WS_B}', '${SEQ_B}', 1, 'email', 'email', false, 'Hola');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id) VALUES
      ('${ENR_A}', '${WS_A}', '${SEQ_A}', '${CONTACT_A}'),
      ('${ENR_B}', '${WS_B}', '${SEQ_B}', '${CONTACT_B}');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, enrollment_id, step_id, channel, body,
                                status, scheduled_for, sent_at, optout_token_hash) VALUES
      ('${TOUCH_SENT}', '${WS_A}', '${COMPANY}', '${CONTACT_A}', '${ENR_A}', '${STEP_A1}', 'email', 'Hola',
       'sent', now() - interval '2 days', now() - interval '2 days', '${sha256(TOKEN)}'),
      ('${TOUCH_PENDING_A}', '${WS_A}', '${COMPANY}', '${CONTACT_A}', '${ENR_A}', '${STEP_A2}', 'email', 'Sigo',
       'scheduled', now() + interval '2 days', NULL, NULL),
      ('${TOUCH_PENDING_B}', '${WS_B}', '${COMPANY}', '${CONTACT_B}', '${ENR_B}', '${STEP_B1}', 'email', 'Hola',
       'scheduled', now() + interval '1 day', NULL, NULL),
      ('${TOUCH_OTRO}', '${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', NULL, NULL, 'email', 'Hola',
       'scheduled', now() + interval '1 day', NULL, '${sha256('token-que-no-salio-nunca-0001')}');
  `);
});

after(async () => {
  await t.close();
});

/** Lo que hay de verdad, sin RLS. */
async function sinRls<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  return t.db.asWorker(async (tx) => (await tx.query<T>(sql)).rows);
}

describe('0037 · catálogos', () => {
  test('los seis ángulos de §5.3, globales, se leen desde cualquier workspace', async () => {
    const keys = await t.db.withWorkspace(WS_B, async (tx) =>
      (await tx.query<{ key: string }>('SELECT key FROM outbound_angle ORDER BY position')).rows.map((r) => r.key),
    );
    assert.deepEqual(keys, [
      'presencia', 'encaje_audiencia', 'prueba_desempeno', 'concepto_creativo', 'prueba_social', 'sintesis',
    ]);
  });

  test('la rúbrica por defecto: 8,0 / 4,5 / cinco intentos; conexión y comentario más laxos', async () => {
    const rows = await t.db.withWorkspace(WS_A, async (tx) =>
      (
        await tx.query<{ step_type: string; threshold: string; min_acceptable: string; max_attempts: number }>(
          'SELECT step_type, threshold, min_acceptable, max_attempts FROM outbound_step_rubric WHERE workspace_id IS NULL',
        )
      ).rows,
    );
    const por = new Map(rows.map((r) => [r.step_type, r]));
    assert.deepEqual({ ...por.get('email') }, { step_type: 'email', threshold: '8.0', min_acceptable: '4.5', max_attempts: 5 });
    for (const laxo of ['linkedin_connect', 'linkedin_comment', 'instagram_comment']) {
      assert.equal(por.get(laxo)?.threshold, '7.0', laxo);
      assert.equal(por.get(laxo)?.min_acceptable, '4.0', laxo);
    }
  });

  test('la plantilla «Marca con campaña activa» tiene seis pasos con ángulos que existen', async () => {
    const [p] = await t.db.withWorkspace(WS_A, async (tx) =>
      (
        await tx.query<{ name_es: string; steps: Array<{ day_offset: number; angle_key: string }> }>(
          "SELECT name_es, steps FROM outbound_sequence_template WHERE slug = 'marca-con-campana-activa'",
        )
      ).rows,
    );
    assert.equal(p?.name_es, 'Marca con campaña activa');
    assert.deepEqual(p?.steps.map((s) => s.day_offset), [0, 1, 3, 5, 7, 9]);
    const angulos = await sinRls<{ key: string }>('SELECT key FROM outbound_angle WHERE workspace_id IS NULL');
    for (const s of p!.steps) assert.ok(angulos.some((a) => a.key === s.angle_key), s.angle_key);
  });

  test('la aplicación no escribe los catálogos globales ni sus contadores', async () => {
    const r = await t.db.withWorkspace(WS_A, (tx) =>
      tx.query("UPDATE outbound_angle SET label_es = 'x' WHERE key = 'presencia' RETURNING id"),
    );
    assert.equal(r.rows.length, 0, 'la política de escritura no alcanza la fila global');
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query("INSERT INTO outbound_sequence_template (slug, name_es, description_es, steps) VALUES ('x-y', 'x', 'x', '[{}]')")),
      /permission denied/,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`SELECT increment_if_under_cap('${WS_A}', 'email', 10)`)),
      /permission denied/,
    );
  });

  test('las funciones de OUTREACH_FUNCTIONS existen con esa firma', async () => {
    for (const firma of Object.values(OUTREACH_FUNCTIONS)) {
      const [r] = await sinRls<{ ok: string | null }>(`SELECT to_regprocedure('${firma}')::text AS ok`);
      assert.ok(r?.ok, firma);
    }
  });
});
