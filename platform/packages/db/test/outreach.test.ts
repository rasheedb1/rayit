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

describe('0037 · límites atómicos', () => {
  /** Una llamada del despachador: su propia transacción, como mc_worker. */
  const llamar = (fn: string, accion: string, tope: number) =>
    t.db.asWorker(async (tx) =>
      (await tx.query<{ ok: boolean }>(`SELECT ${fn}($1, $2, $3) AS ok`, [WS_A, accion, tope])).rows[0]!.ok,
    );
  const cuenta = async (periodo: 'day' | 'week', accion: string) =>
    (
      await sinRls<{ count: number }>(
        `SELECT count FROM outbound_counter WHERE workspace_id = '${WS_A}' AND period = '${periodo}' AND action_type = '${accion}'`,
      )
    ).map((r) => r.count);

  test('increment_if_under_cap: dos llamadas a la vez con una plaza libre dan un true y un false', async () => {
    const [a, b] = await Promise.all([llamar('increment_if_under_cap', 'email', 1), llamar('increment_if_under_cap', 'email', 1)]);
    assert.deepEqual([a, b].sort(), [false, true]);
    assert.deepEqual(await cuenta('day', 'email'), [1], 'una sola fila, del día local, con 1');

    // Con el tope subido a 3 caben exactamente dos más, aunque lleguen cuatro a la vez.
    const otras = await Promise.all([1, 2, 3, 4].map(() => llamar('increment_if_under_cap', 'email', 3)));
    assert.equal(otras.filter(Boolean).length, 2);
    assert.deepEqual(await cuenta('day', 'email'), [3], 'nunca se pasa del tope');
  });

  test('increment_if_under_cap: tope 0 o negativo no deja pasar nada ni crea fila', async () => {
    assert.equal(await llamar('increment_if_under_cap', 'linkedin_invite', 0), false);
    assert.equal(await llamar('increment_if_under_cap', 'linkedin_invite', -5), false);
    assert.deepEqual(await cuenta('day', 'linkedin_invite'), []);
  });

  test('increment_weekly cuenta en la fila de la SEMANA, que es la que bloquea', async () => {
    // Lo que ya se gastó esta semana en otros días: la fila de la semana
    // local (lunes) con 4. La de hoy no existe.
    await t.admin(`
      INSERT INTO outbound_counter (workspace_id, period, period_start, action_type, count)
      VALUES ('${WS_A}', 'week',
              outreach_local_date('${WS_A}', now()) - (extract(isodow FROM outreach_local_date('${WS_A}', now()))::int - 1),
              'linkedin_message', 4);
    `);
    const [a, b] = await Promise.all([
      llamar('increment_weekly', 'linkedin_message', 5),
      llamar('increment_weekly', 'linkedin_message', 5),
    ]);
    assert.deepEqual([a, b].sort(), [false, true]);
    assert.deepEqual(await cuenta('week', 'linkedin_message'), [5]);
    assert.deepEqual(await cuenta('day', 'linkedin_message'), [], 'la semanal no toca la fila del día');
    const [lunes] = await sinRls<{ isodow: number }>(
      `SELECT extract(isodow FROM period_start)::int AS isodow FROM outbound_counter
        WHERE workspace_id = '${WS_A}' AND period = 'week' AND action_type = 'linkedin_message'`,
    );
    assert.equal(lunes?.isodow, 1, 'la semana empieza el lunes');
  });
});

describe('0037 · public_optout, la baja desde el enlace', () => {
  const baja = (token: string) =>
    t.db.withPublicShare(async (tx) => {
      const r = (await tx.query<{ r: Record<string, unknown> }>('SELECT public_optout($1) AS r', [token])).rows[0]!.r;
      const quedan = (
        await tx.query<{ a: string; b: string; c: string }>(
          "SELECT current_setting('app.public_optout', true) AS a, current_setting('app.public_optout_contacts', true) AS b, " +
            "current_setting('app.public_optout_email', true) AS c",
        )
      ).rows[0]!;
      return { r, quedan };
    });

  test('un token inventado, corto o de un toque que no salió no encuentra nada ni cambia nada', async () => {
    for (const token of ['', 'corto', 'x'.repeat(40), 'token-que-no-salio-nunca-0001']) {
      const { r } = await baja(token);
      assert.deepEqual(r, { status: 'not_found' }, token);
    }
    const [otro] = await sinRls<{ status: string; opted_out: boolean }>(
      `SELECT t.status, c.opted_out FROM outbound_touch t JOIN contact c ON c.id = t.contact_id WHERE t.id = '${TOUCH_OTRO}'`,
    );
    assert.deepEqual({ ...otro }, { status: 'scheduled', opted_out: false });
  });

  test('mc_app no abre nada fijando los parámetros a mano: las políticas son de mc_public_share', async () => {
    const vistas = await t.db.withWorkspace(WS_B, async (tx) => {
      await tx.query("SELECT set_config('app.public_optout', $1, true)", [sha256(TOKEN)]);
      await tx.query("SELECT set_config('app.public_optout_contacts', $1, true)", [`{${CONTACT_A}}`]);
      return (await tx.query(`SELECT id FROM outbound_touch WHERE workspace_id = '${WS_A}'`)).rows.length;
    });
    assert.equal(vistas, 0);
  });

  test('marca la baja en todas las fichas de esa persona y cancela lo pendiente en cualquier workspace', async () => {
    const { r, quedan } = await baja(TOKEN);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_A, touchId: TOUCH_SENT });
    assert.deepEqual({ ...quedan }, { a: '', b: '', c: '' }, 'los parámetros no sobreviven a la llamada');

    const contactos = await sinRls<{ id: string; opted_out: boolean; opted_out_at: string | null }>(
      `SELECT id, opted_out, opted_out_at FROM contact WHERE id IN ('${CONTACT_A}', '${CONTACT_B}', '${CONTACT_OTRO}') ORDER BY id`,
    );
    assert.deepEqual(
      contactos.map((c) => [c.id, c.opted_out, c.opted_out_at !== null]),
      [
        [CONTACT_A, true, true],
        [CONTACT_OTRO, false, false],
        [CONTACT_B, true, true],
      ],
    );

    const toques = await sinRls<{ id: string; status: string; blocked_reason: string | null }>(
      `SELECT id, status, blocked_reason FROM outbound_touch ORDER BY id`,
    );
    assert.deepEqual(
      toques.map((x) => [x.id, x.status, x.blocked_reason]),
      [
        [TOUCH_SENT, 'sent', null],
        [TOUCH_PENDING_A, 'canceled', 'opted_out'],
        [TOUCH_OTRO, 'scheduled', null],
        [TOUCH_PENDING_B, 'canceled', 'opted_out'],
      ],
    );

    const enrolamientos = await sinRls<{ id: string; status: string }>('SELECT id, status FROM outbound_enrollment ORDER BY id');
    assert.deepEqual(enrolamientos.map((e) => [e.id, e.status]), [[ENR_A, 'opted_out'], [ENR_B, 'opted_out']]);

    const supresion = await sinRls<{ reason: string }>("SELECT reason FROM contact_suppression WHERE email = 'marta@cafe.test'");
    assert.deepEqual(supresion.map((s) => s.reason), ['unsubscribe_link']);
  });

  test('pulsar el enlace otra vez responde lo mismo y no rompe nada', async () => {
    const { r } = await baja(TOKEN);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: true, workspaceId: WS_A, touchId: TOUCH_SENT });
  });

  test('y la regla dura de 0007 ya no deja reprogramar ni reclamar a esa persona', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query(`UPDATE outbound_touch SET status = 'scheduled' WHERE id = '${TOUCH_PENDING_B}'`),
      ),
      /opt-out/,
    );
    await assert.rejects(
      t.db.asWorker((tx) =>
        tx.query(`UPDATE outbound_touch SET status = 'processing', claimed_at = now() WHERE id = '${TOUCH_PENDING_A}'`),
      ),
      /opt-out/,
    );
  });
});

describe('0037 · el interruptor, la salud y los días hábiles', () => {
  test('sin dirección postal no se enciende; con ella, sí, y apagar cancela lo que está en cola', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`SELECT enable_outreach('${WS_A}')`)),
      (e: { code?: string; message?: string }) => e.code === '23514' && /Sin dirección postal/.test(e.message ?? ''),
    );
    // Y aunque alguien escriba la fila a mano, el CHECK tampoco lo deja.
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`INSERT INTO outbound_policy (workspace_id, enabled) VALUES ('${WS_A}', true)`)),
      /outbound_policy_enabled_needs_address/,
    );
    const antes = await t.db.withWorkspace(WS_A, async (tx) => {
      await tx.query(
        `INSERT INTO outbound_policy (workspace_id, postal_address) VALUES ('${WS_A}', 'Calle 1 # 2-3, Bogotá')
         ON CONFLICT (workspace_id) DO UPDATE SET postal_address = EXCLUDED.postal_address`,
      );
      await tx.query(`SELECT enable_outreach('${WS_A}')`);
      return (await tx.query<{ p: boolean }>(`SELECT should_pause_outreach('${WS_A}') AS p`)).rows[0]!.p;
    });
    assert.equal(antes, false, 'encendido y sin cola llena: no se para');

    await t.admin(`UPDATE outbound_touch SET status = 'scheduled', blocked_reason = NULL WHERE id = '${TOUCH_OTRO}'`);
    const { cancelados, pausa } = await t.db.withWorkspace(WS_A, async (tx) => ({
      cancelados: (await tx.query<{ n: number }>(`SELECT disable_outreach('${WS_A}', 'Revisión de la cuenta') AS n`)).rows[0]!.n,
      pausa: (await tx.query<{ p: boolean }>(`SELECT should_pause_outreach('${WS_A}') AS p`)).rows[0]!.p,
    }));
    assert.equal(cancelados, 1);
    assert.equal(pausa, true);
    const [otro] = await sinRls<{ status: string; blocked_reason: string }>(
      `SELECT status, blocked_reason FROM outbound_touch WHERE id = '${TOUCH_OTRO}'`,
    );
    assert.deepEqual({ ...otro }, { status: 'canceled', blocked_reason: 'outreach_disabled' });
  });

  test('desde otro workspace no se apaga ni se enciende el de A', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query(`SELECT disable_outreach('${WS_A}', 'sabotaje')`)),
      /no puede ver/,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query(`SELECT enable_outreach('${WS_A}')`)),
      /Sin dirección postal/,
      'la fila de A no se ve desde B: para B no existe',
    );
    const [a] = await sinRls<{ enabled: boolean; disabled_reason: string }>(
      `SELECT enabled, disabled_reason FROM outbound_policy WHERE workspace_id = '${WS_A}'`,
    );
    assert.deepEqual({ ...a }, { enabled: false, disabled_reason: 'Revisión de la cuenta' });
  });

  test('outbound_health devuelve la salud en jsonb, con la cola y el motivo del apagado', async () => {
    const h = await t.db.withWorkspace(WS_A, async (tx) =>
      (await tx.query<{ h: Record<string, any> }>(`SELECT outbound_health('${WS_A}', 72) AS h`)).rows[0]!.h,
    );
    assert.equal(h.enabled, false);
    assert.equal(h.disabledReason, 'Revisión de la cuenta');
    assert.equal(h.shouldPause, true);
    assert.equal(h.hours, 72);
    assert.deepEqual(h.queue, { draft: 0, scheduled: 0, due: 0, processing: 0, stuck: 0, held: 0 });
    assert.equal(h.window.sent, 1);
    assert.equal(h.window.optedOut, 1);
    assert.deepEqual(h.byChannel, { email: { sent: 1, failed: 0 } });
    assert.deepEqual(h.llm, { spentToday: 0, dailyCap: 5, currency: 'USD' });
  });

  test('next_business_day: el siguiente día hábil a la misma hora local, saltando el fin de semana', async () => {
    const casos: Array<[string, string, string]> = [
      // viernes 25-sep-2026 10:00 en Bogotá (UTC-5) → lunes 28 a las 10:00
      ['2026-09-25T15:00:00Z', 'America/Bogota', '2026-09-28T15:00:00.000Z'],
      // sábado → lunes
      ['2026-09-26T15:00:00Z', 'America/Bogota', '2026-09-28T15:00:00.000Z'],
      // lunes → martes
      ['2026-09-28T15:00:00Z', 'America/Bogota', '2026-09-29T15:00:00.000Z'],
      // viernes 23:30 en Madrid ya es sábado en UTC: cuenta el día LOCAL → lunes 23:30 local
      ['2026-10-23T21:30:00Z', 'Europe/Madrid', '2026-10-26T22:30:00.000Z'],
    ];
    for (const [ts, tz, esperado] of casos) {
      const [r] = await sinRls<{ d: string }>(`SELECT next_business_day('${ts}'::timestamptz, '${tz}') AS d`);
      assert.equal(new Date(r!.d).toISOString(), esperado, `${ts} ${tz}`);
    }
    await assert.rejects(sinRls(`SELECT next_business_day(now(), 'Bogota')`), /time zone/);
  });
});
