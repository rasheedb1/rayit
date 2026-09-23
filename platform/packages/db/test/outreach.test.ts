/**
 * VEN-9 · la migración de outreach (0037) en Postgres embebido.
 *
 *   · los catálogos que trae: seis ángulos, la rúbrica por defecto (con
 *     pesos que la base comprueba) y la plantilla «Marca con campaña
 *     activa»; active como sombra de status en la secuencia; Gmail en
 *     minúsculas;
 *   · increment_if_under_cap e increment_weekly: dos llamadas a la vez con
 *     una plaza libre dan un true y un false, nunca dos true; por cuenta,
 *     cada cuenta tiene su plaza;
 *   · public_optout: la baja desde el enlace cruza workspaces, anota la
 *     supresión global y no deja nada pendiente; el token que no salió, o
 *     uno inventado, no encuentra nada; y un workspace no puede fabricarse
 *     un toque «enviado» para dar de baja el correo de otro;
 *   · la regla de la baja en las transiciones: tras la baja se sigue
 *     anotando la respuesta, y lo que estaba saliendo se registra;
 *   · el interruptor (disable/enable/should_pause), la salud y los días
 *     hábiles.
 *
 * CONCURRENCIA. PGlite serializa las transacciones (test/pglite.ts), así
 * que aquí los Promise.all de los límites no se pisan de verdad: pasarían
 * igual con una función que leyera y luego escribiera. La garantía real
 * (la segunda llamada ESPERA el bloqueo de la fila y ve la plaza gastada)
 * la prueba «el bloqueo es de verdad», que solo corre con
 * TEST_DATABASE_URL: el job contra-postgres-real del CI corre
 * `pnpm --filter @mc/db test`, que incluye este archivo.
 *
 * Sin red y sin seeds: cada escenario se siembra como superusuario
 * (admin) y se ejercita con el rol de verdad (mc_app en withWorkspace o
 * withPublicShare, mc_worker en asWorker).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { WorkerTx } from '../src/client.ts';
import {
  disableOutreach, enableOutreach, incrementIfUnderCap, incrementWeekly, nextBusinessDay, outboundHealth,
  OutreachShapeError, parseOutboundHealth, parsePublicOptout, publicOptout, shouldPauseOutreach,
} from '../src/queries/outreach.ts';
import { OUTREACH_FUNCTIONS, WORKER_ONLY_TOUCH_COLUMNS } from '../src/schema/outreach.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const WS_A = '00000037-0000-4000-8000-00000000000a';
const WS_B = '00000037-0000-4000-8000-00000000000b';
const COMPANY = '00000037-0000-4000-8000-0000000000c1';
const CONTACT_A = '00000037-0000-4000-8000-0000000000a1';
const CONTACT_B = '00000037-0000-4000-8000-0000000000b1';
const CONTACT_OTRO = '00000037-0000-4000-8000-0000000000a2';
/** La persona que alguien quiere dar de baja sin haberle escrito: su ficha en A… */
const CONTACT_VICTIMA = '00000037-0000-4000-8000-0000000000a3';
/** …y la ficha con su mismo correo que se inventa el workspace B. */
const CONTACT_SABOTAJE = '00000037-0000-4000-8000-0000000000b2';
/** Alguien de A a quien solo se le envió un correo y que pulsa su enlace sin nada pendiente. */
const CONTACT_SOLA = '00000037-0000-4000-8000-0000000000a4';
const SEQ_A = '00000037-0000-4000-8000-0000000005a1';
const SEQ_B = '00000037-0000-4000-8000-0000000005b1';
const STEP_A1 = '00000037-0000-4000-8000-0000000051a1';
const STEP_A2 = '00000037-0000-4000-8000-0000000051a2';
const STEP_B1 = '00000037-0000-4000-8000-0000000051b1';
const ENR_A = '00000037-0000-4000-8000-00000000e0a1';
const ENR_B = '00000037-0000-4000-8000-00000000e0b1';
const TOUCH_SENT = '00000037-0000-4000-8000-0000000070a1';
const TOUCH_PENDING_A = '00000037-0000-4000-8000-0000000070a2';
const TOUCH_OTRO = '00000037-0000-4000-8000-0000000070a3';
/** 'sent' con el sha256 de un token pero sin provider_message_id: no prueba que saliera. */
const TOUCH_SIN_ID = '00000037-0000-4000-8000-0000000070a4';
const TOUCH_SOLA = '00000037-0000-4000-8000-0000000070a5';
/** Un fallo de hace un mes: no es de la ventana aunque hoy se le anote algo. */
const TOUCH_FALLIDO = '00000037-0000-4000-8000-0000000070a6';
const TOUCH_PENDING_B = '00000037-0000-4000-8000-0000000070b1';
/** Reclamado por el despachador cuando llega la baja. */
const TOUCH_EN_VUELO = '00000037-0000-4000-8000-0000000070b2';
const ACC_A1 = '00000037-0000-4000-8000-00000000aca1';
const ACC_A2 = '00000037-0000-4000-8000-00000000aca2';
const ACC_B1 = '00000037-0000-4000-8000-00000000acb1';
/** Una empresa propia de B, para intentar mover a ella un toque enviado. */
const COMPANY_B = '00000037-0000-4000-8000-0000000000c2';
/** B se escribe a sí mismo por la plataforma: un envío de verdad, con su enlace en la carpeta de enviados. */
const CONTACT_YO_B = '00000037-0000-4000-8000-0000000000b3';
const TOUCH_YO_B = '00000037-0000-4000-8000-0000000070b3';
/** Una persona a la que A le escribió y cuya ficha A borra después; B la tiene con el mismo correo. */
const CONTACT_BORRADA = '00000037-0000-4000-8000-0000000000a5';
const CONTACT_BORRADA_B = '00000037-0000-4000-8000-0000000000b4';
const TOUCH_BORRADA = '00000037-0000-4000-8000-0000000070a7';
const TOUCH_BORRADA_B = '00000037-0000-4000-8000-0000000070b4';

const TOKEN = 'k2Jd8sQ0pX4vN7bW1eR5tY9uI3oP6aS0';
const TOKEN_SIN_ID = 'sin-id-del-proveedor-0000000000001';
const TOKEN_SOLA = 'z9Yx8Wv7Ut6Sr5Qp4On3Ml2Kj1Ih0Gf9';
const TOKEN_YO_B = 'yo-b-1234567890-abcdefghijklmnopq';
const TOKEN_BORRADA = 'borrada-0987654321-zyxwvutsrqponm';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  // Dos workspaces que escriben a la MISMA persona (mismo correo, dos
  // fichas), y contactos de A que no tienen nada que ver.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS_A}', 'outreach-a', 'Outreach A', 'America/Bogota'),
      ('${WS_B}', 'outreach-b', 'Outreach B', 'Europe/Madrid');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY}', 'Café de prueba', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${COMPANY}'), ('${WS_B}', '${COMPANY}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${CONTACT_A}', '${COMPANY}', 'Marta Marca', 'marta@cafe.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_B}', '${COMPANY}', 'Marta M.', 'MARTA@cafe.test', 'user_provided', '${WS_B}'),
      ('${CONTACT_OTRO}', '${COMPANY}', 'Otra persona', 'otra@cafe.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_VICTIMA}', '${COMPANY}', 'Víctima', 'victima@cafe.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_SABOTAJE}', '${COMPANY}', 'Víctima (copia de B)', 'victima@cafe.test', 'user_provided', '${WS_B}'),
      ('${CONTACT_SOLA}', '${COMPANY}', 'Sola', 'sola@cafe.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_YO_B}', '${COMPANY}', 'Yo mismo (B)', 'yo@outreach-b.test', 'user_provided', '${WS_B}'),
      ('${CONTACT_BORRADA}', '${COMPANY}', 'Borrada', 'borrada@cafe.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_BORRADA_B}', '${COMPANY}', 'Borrada (B)', 'borrada@cafe.test', 'user_provided', '${WS_B}');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_B}', 'Empresa de B', '${WS_B}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_B}', '${COMPANY_B}');
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
    -- Lo que dejó el despachador (admin hace de worker): el hash y el id del proveedor.
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, enrollment_id, step_id, channel, body,
                                status, scheduled_for, sent_at, claimed_at, optout_token_hash, provider_message_id,
                                recipient_address) VALUES
      ('${TOUCH_SENT}', '${WS_A}', '${COMPANY}', '${CONTACT_A}', '${ENR_A}', '${STEP_A1}', 'email', 'Hola',
       'sent', now() - interval '2 days', now() - interval '2 days', NULL, '${sha256(TOKEN)}', 'gmail-0001',
       'marta@cafe.test'),
      ('${TOUCH_PENDING_A}', '${WS_A}', '${COMPANY}', '${CONTACT_A}', '${ENR_A}', '${STEP_A2}', 'email', 'Sigo',
       'scheduled', now() + interval '2 days', NULL, NULL, NULL, NULL, NULL),
      ('${TOUCH_PENDING_B}', '${WS_B}', '${COMPANY}', '${CONTACT_B}', '${ENR_B}', '${STEP_B1}', 'email', 'Hola',
       'scheduled', now() + interval '1 day', NULL, NULL, NULL, NULL, NULL),
      ('${TOUCH_EN_VUELO}', '${WS_B}', '${COMPANY}', '${CONTACT_B}', NULL, NULL, 'email', 'Hola otra vez',
       'processing', now() - interval '1 minute', NULL, now() - interval '30 seconds', NULL, NULL, NULL),
      ('${TOUCH_OTRO}', '${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', NULL, NULL, 'email', 'Hola',
       'scheduled', now() + interval '1 day', NULL, NULL, '${sha256('token-que-no-salio-nunca-0001')}', NULL, NULL),
      ('${TOUCH_SIN_ID}', '${WS_A}', '${COMPANY}', '${CONTACT_VICTIMA}', NULL, NULL, 'email', 'Hola',
       'sent', now() - interval '1 day', now() - interval '1 day', NULL, '${sha256(TOKEN_SIN_ID)}', NULL,
       'victima@cafe.test'),
      ('${TOUCH_SOLA}', '${WS_A}', '${COMPANY}', '${CONTACT_SOLA}', NULL, NULL, 'email', 'Hola',
       'sent', now() - interval '1 day', now() - interval '1 day', NULL, '${sha256(TOKEN_SOLA)}', 'gmail-0002',
       'sola@cafe.test'),
      -- Enviados hace cinco días: fuera de la ventana de 72 h de la salud.
      ('${TOUCH_YO_B}', '${WS_B}', '${COMPANY}', '${CONTACT_YO_B}', NULL, NULL, 'email', 'Prueba',
       'sent', now() - interval '5 days', now() - interval '5 days', NULL, '${sha256(TOKEN_YO_B)}', 'gmail-b-0003',
       'yo@outreach-b.test'),
      ('${TOUCH_BORRADA}', '${WS_A}', '${COMPANY}', '${CONTACT_BORRADA}', NULL, NULL, 'email', 'Hola',
       'sent', now() - interval '5 days', now() - interval '5 days', NULL, '${sha256(TOKEN_BORRADA)}', 'gmail-0003',
       'borrada@cafe.test'),
      ('${TOUCH_BORRADA_B}', '${WS_B}', '${COMPANY}', '${CONTACT_BORRADA_B}', NULL, NULL, 'email', 'Hola',
       'scheduled', now() + interval '6 days', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, status_changed_at, created_at)
    VALUES ('${TOUCH_FALLIDO}', '${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', 'email', 'Hola', 'failed',
            now() - interval '30 days', now() - interval '31 days');
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status) VALUES
      ('${ACC_A1}', '${WS_A}', 'linkedin', 'unipile', 'unipile-A1', 'connected'),
      ('${ACC_A2}', '${WS_A}', 'linkedin', 'unipile', 'unipile-A2', 'connected'),
      ('${ACC_B1}', '${WS_B}', 'linkedin', 'unipile', 'unipile-B1', 'connected');
  `);
});

after(async () => {
  // Contra un Postgres que se queda (TEST_DATABASE_URL), la prueba se
  // puede volver a correr: se lleva lo suyo. Los workspaces arrastran
  // fichas, toques y contadores; la empresa compartida y la lista global,
  // no.
  if (t.kind === 'postgres') {
    await t.admin(`
      DELETE FROM workspace WHERE id IN ('${WS_A}', '${WS_B}');
      DELETE FROM company WHERE id IN ('${COMPANY}', '${COMPANY_B}');
      DELETE FROM contact_suppression WHERE email IN
        ('marta@cafe.test', 'sola@cafe.test', 'yo@outreach-b.test', 'borrada@cafe.test');
    `);
  }
  await t.close();
});

/** Lo que hay de verdad, sin RLS. */
async function sinRls<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  return t.db.asWorker(async (tx) => (await tx.query<T>(sql)).rows);
}

/** Un toque por id, visto por el worker. */
async function toque(id: string) {
  const [r] = await sinRls<{ status: string; blocked_reason: string | null; status_changed_at: string }>(
    `SELECT status, blocked_reason, status_changed_at::text FROM outbound_touch WHERE id = '${id}'`,
  );
  return r!;
}

/** La página de baja: public_optout sin sesión, y lo que queda en la transacción al salir. */
const baja = (token: string) =>
  t.db.withPublicShare(async (tx) => {
    const r = await publicOptout(tx, token);
    const quedan = (
      await tx.query<{ a: string; b: string; c: string }>(
        "SELECT current_setting('app.public_optout', true) AS a, current_setting('app.public_optout_contacts', true) AS b, " +
          "current_setting('app.public_optout_email', true) AS c",
      )
    ).rows[0]!;
    return { r, quedan };
  });

/** Los permisos de mc_app solo se miden en PGlite: en el CI el rol de conexión también es miembro de mc_worker. */
const soloEmbebido = () => t.kind === 'pglite';

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

  test('los pesos de una rúbrica editada: las cuatro dimensiones, números no negativos que suman 1', async () => {
    const alta = (pesos: string) =>
      t.db.withWorkspace(WS_A, (tx) =>
        tx.query(
          `INSERT INTO outbound_step_rubric (workspace_id, step_type, day_offset, weights) VALUES ($1, 'email', 3, $2::jsonb)`,
          [WS_A, pesos],
        ),
      );
    for (const malo of [
      '{"relevance":5}',
      '{"relevance":0.5,"quality":0.5,"structure":0.5,"voice":0.5}',
      '{"relevance":"0.25","quality":0.25,"structure":0.25,"voice":0.25}',
      '{"relevance":1.2,"quality":-0.2,"structure":0,"voice":0}',
      '{"relevance":0.25,"quality":0.25,"structure":0.25,"voice":0.25,"extra":0}',
      '[0.25,0.25,0.25,0.25]',
    ]) {
      await assert.rejects(alta(malo), /outbound_step_rubric_weights_check/, malo);
    }
    await alta('{"relevance":0.4,"quality":0.2,"structure":0.2,"voice":0.2}');
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

  test('la aplicación no escribe los catálogos globales ni sus contadores', async (ctx) => {
    const r = await t.db.withWorkspace(WS_A, (tx) =>
      tx.query("UPDATE outbound_angle SET label_es = 'x' WHERE key = 'presencia' RETURNING id"),
    );
    assert.equal(r.rows.length, 0, 'la política de escritura no alcanza la fila global');
    if (!soloEmbebido()) return ctx.skip('los GRANT de mc_app se miden en PGlite: en el CI el rol hereda los de mc_worker');
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

  test('outbound_sequence: status manda y active es su sombra, se escriba el que se escriba', async () => {
    const leer = async (id: string) =>
      (await sinRls<{ status: string; active: boolean }>(`SELECT status, active FROM outbound_sequence WHERE id = '${id}'`))[0];
    await t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_sequence SET active = false WHERE id = $1`, [SEQ_A]));
    assert.deepEqual({ ...(await leer(SEQ_A)) }, { status: 'paused', active: false }, 'la pantalla vieja pausa también al motor');
    await t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_sequence SET status = 'archived' WHERE id = $1`, [SEQ_A]));
    assert.deepEqual({ ...(await leer(SEQ_A)) }, { status: 'archived', active: false });
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`UPDATE outbound_sequence SET status = 'active', active = false WHERE id = $1`, [SEQ_A]),
    );
    assert.deepEqual({ ...(await leer(SEQ_A)) }, { status: 'active', active: true }, 'si no concuerdan, gana status');

    const [nueva] = await t.db.withWorkspace(WS_A, async (tx) =>
      (
        await tx.query<{ status: string; active: boolean }>(
          `INSERT INTO outbound_sequence (workspace_id, name, channel) VALUES ($1, 'Nueva', 'email') RETURNING status, active`,
          [WS_A],
        )
      ).rows,
    );
    assert.deepEqual({ ...nueva }, { status: 'draft', active: false }, 'una secuencia nueva no arranca sola');
  });

  test('la dirección de Gmail se guarda en minúsculas: un buzón, una cuenta', async () => {
    const alta = (direccion: string) =>
      t.db.withWorkspace(WS_A, (tx) =>
        tx.query(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id)
           VALUES ($1, 'email', 'gmail_oauth', $2)`,
          [WS_A, direccion],
        ),
      );
    await assert.rejects(alta('Laura@Gmail.com'), /outreach_channel_account_gmail_lower_check/);
    await alta('laura@gmail.com');
    await assert.rejects(alta('laura@gmail.com'), /outreach_channel_account_(provider|live)_idx/);
  });

  test('un buzón vivo es de un solo workspace: la agencia no conecta el Gmail que ya envía desde el creador', async () => {
    const alta = (ws: string, direccion: string) =>
      t.db.withWorkspace(ws, (tx) =>
        tx.query(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
           VALUES ($1, 'email', 'gmail_oauth', $2, 'connected') RETURNING id`,
          [ws, direccion],
        ),
      );
    const { id } = (await alta(WS_A, 'creador@gmail.com')).rows[0] as { id: string };
    // Dos filas vivas del mismo buzón serían dos contadores y el doble de envíos.
    await assert.rejects(alta(WS_B, 'creador@gmail.com'), /outreach_channel_account_live_idx/);
    // Lo mismo con una cuenta de Unipile.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
           VALUES ($1, 'linkedin', 'unipile', 'unipile-A1', 'connected')`,
          [WS_B],
        ),
      ),
      /outreach_channel_account_live_idx/,
    );
    // Desconectado en A, B lo puede conectar.
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`UPDATE outreach_channel_account SET status = 'disconnected' WHERE id = $1`, [id]),
    );
    await alta(WS_B, 'creador@gmail.com');
  });
});

describe('0037 · límites atómicos', () => {
  /** Los envoltorios de queries/outreach.ts, por el nombre de la función SQL. */
  const envoltorio = { increment_if_under_cap: incrementIfUnderCap, increment_weekly: incrementWeekly } as const;
  type Fn = keyof typeof envoltorio;
  /** Una llamada del despachador: su propia transacción, como mc_worker. */
  const llamar = (fn: Fn, accion: string, tope: number) =>
    t.db.asWorker((tx) => envoltorio[fn](tx, { workspaceId: WS_A, actionType: accion, cap: tope }));
  /** La misma, con la cuenta que envía. */
  const llamarCuenta = (fn: Fn, cuenta: string, accion: string, tope: number) =>
    t.db.asWorker((tx) => envoltorio[fn](tx, { workspaceId: WS_A, accountId: cuenta, actionType: accion, cap: tope }));
  const cuenta = async (periodo: 'day' | 'week', accion: string, cuentaId: string | null = null) =>
    (
      await sinRls<{ count: number }>(
        `SELECT count FROM outbound_counter WHERE workspace_id = '${WS_A}' AND period = '${periodo}' AND action_type = '${accion}'
            AND channel_account_id IS NOT DISTINCT FROM ${cuentaId ? `'${cuentaId}'::uuid` : 'NULL'}`,
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

  test('por cuenta: dos LinkedIn del mismo workspace no se comen la plaza, y el workspace cuenta aparte', async () => {
    assert.equal(await llamarCuenta('increment_if_under_cap', ACC_A1, 'linkedin_invite', 1), true);
    assert.equal(await llamarCuenta('increment_if_under_cap', ACC_A1, 'linkedin_invite', 1), false, 'A1 agotó la suya');
    assert.equal(await llamarCuenta('increment_if_under_cap', ACC_A2, 'linkedin_invite', 1), true, 'A2 tiene la suya');
    // El contador del workspace entero (cuenta NULL) es otra fila, y NULL
    // no es distinto de NULL: la segunda llamada choca con la primera.
    assert.equal(await llamar('increment_if_under_cap', 'linkedin_invite', 1), true);
    assert.equal(await llamar('increment_if_under_cap', 'linkedin_invite', 1), false);
    assert.deepEqual(await cuenta('day', 'linkedin_invite', ACC_A1), [1]);
    assert.deepEqual(await cuenta('day', 'linkedin_invite', ACC_A2), [1]);
    assert.deepEqual(await cuenta('day', 'linkedin_invite'), [1]);

    // La semana por cuenta, igual; y a la vez sobre la misma cuenta, uno y uno.
    const [a, b] = await Promise.all([
      llamarCuenta('increment_weekly', ACC_A2, 'linkedin_invite', 1),
      llamarCuenta('increment_weekly', ACC_A2, 'linkedin_invite', 1),
    ]);
    assert.deepEqual([a, b].sort(), [false, true]);
    assert.deepEqual(await cuenta('week', 'linkedin_invite', ACC_A2), [1]);
  });

  test('los envoltorios validan antes de llamar: acción, cuenta y tope con forma', async () => {
    const base = { workspaceId: WS_A, actionType: 'email', cap: 1 };
    for (const malo of [
      { ...base, actionType: 'Email' },
      { ...base, actionType: ACC_A1 },
      { ...base, accountId: 'no-soy-uuid' },
      { ...base, cap: 1.5 },
      { ...base, workspaceId: 'laura' },
    ]) {
      await assert.rejects(
        t.db.asWorker((tx) => incrementIfUnderCap(tx, malo)),
        // Lo rechaza el envoltorio (sin código de Postgres), no la base.
        (e: { code?: string }) => e instanceof Error && e.code === undefined,
        JSON.stringify(malo),
      );
    }
  });

  test('por cuenta: la cuenta tiene que ser del workspace que cuenta', async () => {
    await assert.rejects(llamarCuenta('increment_if_under_cap', ACC_B1, 'linkedin_invite', 5), /no es del workspace/);
    await assert.rejects(llamarCuenta('increment_weekly', ACC_B1, 'linkedin_invite', 5), /no es del workspace/);
  });

  /**
   * La prueba que falla con una función que lee y luego escribe: la
   * primera transacción suma y NO confirma; la segunda tiene que quedarse
   * esperando el bloqueo de la fila (no leer el 0 de antes) y, al
   * confirmar la primera, ver la plaza gastada. Solo en Postgres real.
   */
  const bloqueoDeVerdad = async (fn: Fn, accion: string, cuentaId: string | null) => {
    const una = (tx: WorkerTx) => envoltorio[fn](tx, { workspaceId: WS_A, accountId: cuentaId, actionType: accion, cap: 1 });
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    let sumo!: () => void;
    const primeraSumo = new Promise<void>((r) => (sumo = r));
    const primera = t.db.asWorker(async (tx) => {
      const ok = await una(tx);
      sumo();
      await puerta;
      return ok;
    });
    await primeraSumo;
    let resuelta = false;
    const segunda = t.db.asWorker((tx) => una(tx)).then((ok) => ((resuelta = true), ok));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(resuelta, false, `${fn}: la segunda espera el bloqueo de la fila del periodo`);
    soltar();
    assert.deepEqual([await primera, await segunda], [true, false], `${fn}: la segunda ve la plaza ya gastada`);
  };

  test('el bloqueo es de verdad: la segunda llamada espera a la primera (solo Postgres real)', async (ctx) => {
    if (t.kind !== 'postgres') {
      return ctx.skip('PGlite serializa las transacciones; lo corre el job contra-postgres-real con TEST_DATABASE_URL');
    }
    await bloqueoDeVerdad('increment_if_under_cap', 'email_real', null);
    await bloqueoDeVerdad('increment_weekly', 'email_real', null);
    await bloqueoDeVerdad('increment_if_under_cap', 'linkedin_real', ACC_A1);
    await bloqueoDeVerdad('increment_weekly', 'linkedin_real', ACC_A1);
  });
});

describe('0037 · public_optout, la baja desde el enlace', () => {
  test('un token inventado, corto, de un toque que no salió o sin id del proveedor no encuentra nada', async () => {
    for (const token of ['', 'corto', 'x'.repeat(40), 'token-que-no-salio-nunca-0001', TOKEN_SIN_ID]) {
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

  test('sabotaje: un workspace no se fabrica un toque «enviado» para dar de baja el correo de otra persona', async () => {
    const TOKEN_FALSO = 'token-inventado-por-el-workspace-b-0001';
    const sabotaje = (sql: string, params: unknown[] = []) => t.db.withWorkspace(WS_B, (tx) => tx.query(sql, params));
    const soloElDespachador = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /los escribe solo el despachador/.test(e.message ?? '');

    // El alta con el hash de un token propio, o con un id de proveedor, no entra.
    for (const [columna, valor] of [
      ['optout_token_hash', sha256(TOKEN_FALSO)],
      ['provider_message_id', 'gmail-falso'],
      ['message_id_rfc', '<falso@mail.gmail.com>'],
    ] as const) {
      assert.ok((WORKER_ONLY_TOUCH_COLUMNS as readonly string[]).includes(columna));
      await assert.rejects(
        sabotaje(
          `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, sent_at, ${columna})
           VALUES ($1, $2, $3, 'email', 'x', 'sent', now(), $4)`,
          [WS_B, COMPANY, CONTACT_SABOTAJE, valor],
        ),
        soloElDespachador,
        columna,
      );
    }

    // Tampoco en dos pasos: el toque «enviado» sin pruebas entra (es un
    // registro suyo), pero ponerle el hash o el id después, no.
    const { id } = (
      await sabotaje(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, sent_at)
         VALUES ($1, $2, $3, 'email', 'x', 'sent', now()) RETURNING id`,
        [WS_B, COMPANY, CONTACT_SABOTAJE],
      )
    ).rows[0] as { id: string };
    for (const columna of WORKER_ONLY_TOUCH_COLUMNS) {
      const valor = columna === 'optout_token_hash' ? sha256(TOKEN_FALSO) : 'falso';
      await assert.rejects(sabotaje(`UPDATE outbound_touch SET ${columna} = $1 WHERE id = $2`, [valor, id]), soloElDespachador, columna);
    }
    assert.deepEqual((await baja(TOKEN_FALSO)).r, { status: 'not_found' });

    // Y la víctima sigue igual en todas partes.
    const fichas = await sinRls<{ opted_out: boolean }>(
      `SELECT opted_out FROM contact WHERE id IN ('${CONTACT_VICTIMA}', '${CONTACT_SABOTAJE}')`,
    );
    assert.deepEqual(fichas.map((f) => f.opted_out), [false, false]);
    assert.deepEqual(await sinRls("SELECT 1 FROM contact_suppression WHERE email = 'victima@cafe.test'"), []);

    // El despachador sí escribe esas columnas: son suyas.
    await t.db.asWorker((tx) =>
      tx.query(`UPDATE outbound_touch SET provider_message_id = 'gmail-b-0001', message_id_rfc = '<b1@mail>' WHERE id = $1`, [id]),
    );
    await t.admin(`DELETE FROM outbound_touch WHERE id = '${id}'`);
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

    const esperado: Record<string, [string, string | null]> = {
      [TOUCH_SENT]: ['sent', null],
      [TOUCH_PENDING_A]: ['canceled', 'opted_out'],
      [TOUCH_PENDING_B]: ['canceled', 'opted_out'],
      [TOUCH_OTRO]: ['scheduled', null],
      // Lo reclamado es del despachador: la baja no lo toca (0037 §4.1).
      [TOUCH_EN_VUELO]: ['processing', null],
    };
    for (const [id, [status, motivo]] of Object.entries(esperado)) {
      const x = await toque(id);
      assert.deepEqual([x.status, x.blocked_reason], [status, motivo], id);
    }

    const enrolamientos = await sinRls<{ id: string; status: string; terminado: boolean }>(
      `SELECT id, status, finished_at IS NOT NULL AS terminado FROM outbound_enrollment
        WHERE id IN ('${ENR_A}', '${ENR_B}') ORDER BY id`,
    );
    assert.deepEqual(
      enrolamientos.map((e) => [e.id, e.status, e.terminado]),
      [
        [ENR_A, 'opted_out', true],
        [ENR_B, 'opted_out', true],
      ],
      'la baja termina los enrolamientos y dice cuándo',
    );

    const supresion = await sinRls<{ reason: string }>("SELECT reason FROM contact_suppression WHERE email = 'marta@cafe.test'");
    assert.deepEqual(supresion.map((s) => s.reason), ['unsubscribe_link']);
  });

  test('sabotaje: un toque enviado de verdad no cambia de destinatario desde la web', async () => {
    const b = (sql: string, params: unknown[]) => t.db.withWorkspace(WS_B, (tx) => tx.query(sql, params));
    const destinatarioFijo = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /no cambia de destinatario/.test(e.message ?? '');

    // B se escribió a sí mismo por la plataforma y tiene el enlace en su
    // carpeta de enviados. Mover ese toque a la ficha con el correo de la
    // víctima, o a otra empresa, no se deja.
    await assert.rejects(b('UPDATE outbound_touch SET contact_id = $1 WHERE id = $2', [CONTACT_SABOTAJE, TOUCH_YO_B]), destinatarioFijo);
    await assert.rejects(b('UPDATE outbound_touch SET company_id = $1 WHERE id = $2', [COMPANY_B, TOUCH_YO_B]), destinatarioFijo);
    // Tampoco en dos pasos: a NULL sí (es lo que hace borrar la ficha), pero de NULL a otra, no.
    await b('UPDATE outbound_touch SET contact_id = NULL WHERE id = $1', [TOUCH_YO_B]);
    await assert.rejects(b('UPDATE outbound_touch SET contact_id = $1 WHERE id = $2', [CONTACT_SABOTAJE, TOUCH_YO_B]), destinatarioFijo);
    // Escribir el mismo valor no es cambiarlo, y un toque sin pruebas de envío sí se mueve.
    await b('UPDATE outbound_touch SET company_id = $1 WHERE id = $2', [COMPANY, TOUCH_YO_B]);
    // El despachador sí puede (es quien fija el destinatario al enviar): deja la ficha como estaba.
    await t.db.asWorker((tx) => tx.query('UPDATE outbound_touch SET contact_id = $1 WHERE id = $2', [CONTACT_YO_B, TOUCH_YO_B]));
  });

  test('sabotaje: cambiar el correo de la ficha después del envío no mueve la baja a otra persona', async () => {
    // B le pone a su propia ficha el correo de una persona que solo A
    // tiene (Otra) y pulsa su enlace.
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.query(`UPDATE contact SET email = 'otra@cafe.test' WHERE id = $1`, [CONTACT_YO_B]),
    );
    const { r } = await baja(TOKEN_YO_B);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_B, touchId: TOUCH_YO_B });
    // Se suprime la dirección a la que salió el correo, no la de hoy.
    const lista = await sinRls<{ email: string }>(
      `SELECT email::text AS email FROM contact_suppression WHERE email IN ('yo@outreach-b.test', 'otra@cafe.test')`,
    );
    assert.deepEqual(lista.map((x) => x.email), ['yo@outreach-b.test']);
    // Otra sigue igual en A, con lo suyo en cola; la ficha de B que recibió el correo, de baja.
    const fichas = await sinRls<{ id: string; opted_out: boolean }>(
      `SELECT id, opted_out FROM contact WHERE id IN ('${CONTACT_OTRO}', '${CONTACT_YO_B}') ORDER BY id`,
    );
    assert.deepEqual(
      fichas.map((f) => [f.id, f.opted_out]),
      [
        [CONTACT_OTRO, false],
        [CONTACT_YO_B, true],
      ],
    );
    assert.equal((await toque(TOUCH_OTRO)).status, 'scheduled');
    // Y el token no se reutiliza contra otra persona: responde lo mismo y no toca a nadie más.
    assert.deepEqual((await baja(TOKEN_YO_B)).r, { status: 'ok', alreadyOptedOut: true, workspaceId: WS_B, touchId: TOUCH_YO_B });
    assert.deepEqual(await sinRls("SELECT 1 FROM contact_suppression WHERE email = 'otra@cafe.test'"), []);
  });

  test('el enlace sigue funcionando si el workspace borró la ficha después del envío', async () => {
    await t.db.withWorkspace(WS_A, (tx) => tx.query('DELETE FROM contact WHERE id = $1', [CONTACT_BORRADA]));
    const [huerfano] = await sinRls<{ contact_id: string | null }>(
      `SELECT contact_id FROM outbound_touch WHERE id = '${TOUCH_BORRADA}'`,
    );
    assert.equal(huerfano?.contact_id, null, 'la clave ajena lo pone a NULL y el candado lo deja');

    const { r } = await baja(TOKEN_BORRADA);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_A, touchId: TOUCH_BORRADA });
    assert.deepEqual(
      (await sinRls<{ reason: string }>("SELECT reason FROM contact_suppression WHERE email = 'borrada@cafe.test'")).map((x) => x.reason),
      ['unsubscribe_link'],
    );
    // La misma persona en B: de baja, y lo que B tenía en cola para ella, cancelado.
    const [enB] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_BORRADA_B}'`);
    assert.equal(enB?.opted_out, true);
    const x = await toque(TOUCH_BORRADA_B);
    assert.deepEqual([x.status, x.blocked_reason], ['canceled', 'opted_out']);
  });

  test('pulsar el enlace otra vez responde lo mismo y no rompe nada', async () => {
    const [antes] = await sinRls<{ f: string }>(`SELECT finished_at::text AS f FROM outbound_enrollment WHERE id = '${ENR_A}'`);
    const { r } = await baja(TOKEN);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: true, workspaceId: WS_A, touchId: TOUCH_SENT });
    const [despues] = await sinRls<{ f: string }>(`SELECT finished_at::text AS f FROM outbound_enrollment WHERE id = '${ENR_A}'`);
    assert.equal(despues?.f, antes?.f, 'finished_at no se mueve');
  });
});

describe('0037 · la regla de la baja, en las transiciones', () => {
  test('tras la baja se sigue anotando lo que pasó en un toque enviado: respuesta, apertura, hilo', async () => {
    await t.db.asWorker((tx) =>
      tx.query(
        `UPDATE outbound_touch SET replied_at = now(), opened_at = now(), thread_ref = 'hilo-1', message_id_rfc = '<a1@mail>'
          WHERE id = $1`,
        [TOUCH_SENT],
      ),
    );
    // También desde la web (el webhook de VEN-14 anota la respuesta con withWorkspace).
    await t.db.withWorkspace(WS_A, (tx) => tx.query('UPDATE outbound_touch SET replied_at = now() WHERE id = $1', [TOUCH_SENT]));
    assert.equal((await toque(TOUCH_SENT)).status, 'sent');
  });

  test('pero no deja reprogramar, reclamar ni registrar como enviado algo nuevo para esa persona', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query(`UPDATE outbound_touch SET status = 'scheduled' WHERE id = $1`, [TOUCH_PENDING_B])),
      /opt-out/,
    );
    await assert.rejects(
      t.db.asWorker((tx) =>
        tx.query(`UPDATE outbound_touch SET status = 'processing', claimed_at = now() WHERE id = $1`, [TOUCH_PENDING_A]),
      ),
      /opt-out/,
    );
    await assert.rejects(
      t.db.asWorker((tx) => tx.query(`UPDATE outbound_touch SET status = 'scheduled' WHERE id = $1`, [TOUCH_SENT])),
      /opt-out/,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) =>
        tx.query(
          `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, sent_at)
           VALUES ($1, $2, $3, 'email', 'x', 'sent', now())`,
          [WS_A, COMPANY, CONTACT_A],
        ),
      ),
      /opt-out/,
      'un alta en sent es registrar un envío que la regla no deja hacer',
    );
    // Ni moviéndolo a otra ficha: cambiar el contacto también es una transición.
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_touch SET contact_id = $1 WHERE id = $2`, [CONTACT_A, TOUCH_OTRO])),
      /opt-out/,
    );
  });

  test('lo que el despachador ya estaba enviando se registra como enviado, marcado', async () => {
    await t.db.asWorker((tx) =>
      tx.query(
        `UPDATE outbound_touch SET status = 'sent', sent_at = now(), provider_message_id = 'gmail-b-0002'
          WHERE id = $1 AND status = 'processing'`,
        [TOUCH_EN_VUELO],
      ),
    );
    const x = await toque(TOUCH_EN_VUELO);
    assert.deepEqual([x.status, x.blocked_reason], ['sent', 'opted_out_in_flight']);
  });

  test('a quien pidió la baja no se le enrola ni se le reanuda; anotar su enrolamiento sí se puede', async () => {
    const optOut = (e: { code?: string; message?: string }) => e.code === '23514' && /opt-out/.test(e.message ?? '');
    const seq = (
      await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO outbound_sequence (workspace_id, name, channel, status) VALUES ($1, 'Otra', 'email', 'active') RETURNING id`,
          [WS_A],
        ),
      )
    ).rows[0]!.id;
    for (const status of ['active', 'paused']) {
      await assert.rejects(
        t.db.withWorkspace(WS_A, (tx) =>
          tx.query(`INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status) VALUES ($1, $2, $3, $4)`, [
            WS_A, seq, CONTACT_A, status,
          ]),
        ),
        optOut,
        status,
      );
    }
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) =>
        tx.query(`UPDATE outbound_enrollment SET status = 'cooldown', resume_at = now() + interval '90 days' WHERE id = $1`, [ENR_A]),
      ),
      optOut,
      'reanudar tampoco',
    );
    // Lo que no es volver a escribirle pasa: anotar el contexto, o darlo por terminado.
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`UPDATE outbound_enrollment SET context = '{"angles_used":["presencia"]}' WHERE id = $1`, [ENR_A]),
    );
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status) VALUES ($1, $2, $3, 'opted_out')`, [
        WS_A, seq, CONTACT_A,
      ]),
    );
    await t.admin(`DELETE FROM outbound_sequence WHERE id = '${seq}'`);
  });

  test('un paso de un enrolamiento tiene un solo toque vivo, también si uno espera revisión (held)', async () => {
    const ENR_OTRO = '00000037-0000-4000-8000-00000000e0a2';
    await t.admin(`
      INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id) VALUES
        ('${ENR_OTRO}', '${WS_A}', '${SEQ_A}', '${CONTACT_OTRO}');
      INSERT INTO outbound_touch (workspace_id, company_id, contact_id, enrollment_id, step_id, channel, body, status, held_reason)
      VALUES ('${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', '${ENR_OTRO}', '${STEP_A1}', 'email', 'Hola', 'held', 'Cifra sin origen');
    `);
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) =>
        tx.query(
          `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, enrollment_id, step_id, channel, body, status, scheduled_for)
           VALUES ($1, $2, $3, $4, $5, 'email', 'Hola', 'scheduled', now() + interval '1 day')`,
          [WS_A, COMPANY, CONTACT_OTRO, ENR_OTRO, STEP_A1],
        ),
      ),
      /outbound_touch_live_step_idx/,
    );
    // Cancelado el retenido, el paso se puede programar otra vez.
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`UPDATE outbound_touch SET status = 'canceled' WHERE enrollment_id = $1 AND status = 'held'`, [ENR_OTRO]),
    );
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, enrollment_id, step_id, channel, body, status, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, 'email', 'Hola', 'scheduled', now() + interval '1 day')`,
        [WS_A, COMPANY, CONTACT_OTRO, ENR_OTRO, STEP_A1],
      ),
    );
    // Lo que sigue (el interruptor) cuenta la cola de A: este escenario no se queda.
    await t.admin(`DELETE FROM outbound_touch WHERE enrollment_id = '${ENR_OTRO}'; DELETE FROM outbound_enrollment WHERE id = '${ENR_OTRO}';`);
  });

  test('status_changed_at solo se mueve cuando cambia el estado', async () => {
    const antes = (await toque(TOUCH_FALLIDO)).status_changed_at;
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`UPDATE outbound_touch SET opened_at = now(), status_changed_at = now() WHERE id = $1`, [TOUCH_FALLIDO]),
    );
    assert.equal((await toque(TOUCH_FALLIDO)).status_changed_at, antes, 'ni escribiéndolo a mano');
  });
});

describe('0037 · el interruptor, la salud y los días hábiles', () => {
  const pausa = (ws: string) => t.db.withWorkspace(ws, (tx) => shouldPauseOutreach(tx));

  test('sin dirección postal no se enciende; con ella, sí, y apagar cancela lo que está en cola', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => enableOutreach(tx)),
      (e: { code?: string; message?: string }) => e.code === '23514' && /Sin dirección postal/.test(e.message ?? ''),
    );
    // Y aunque alguien escriba la fila a mano, el CHECK tampoco lo deja.
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`INSERT INTO outbound_policy (workspace_id, enabled) VALUES ('${WS_A}', true)`)),
      /outbound_policy_enabled_needs_address/,
    );
    await t.db.withWorkspace(WS_A, async (tx) => {
      await tx.query(
        `INSERT INTO outbound_policy (workspace_id, postal_address) VALUES ('${WS_A}', 'Calle 1 # 2-3, Bogotá')
         ON CONFLICT (workspace_id) DO UPDATE SET postal_address = EXCLUDED.postal_address`,
      );
      await enableOutreach(tx);
    });
    assert.equal(await pausa(WS_A), false, 'encendido y sin atraso: no se para');

    // La contrapresión mide ATRASO: lo programado para dentro de días no
    // cuenta, aunque pase del tope; lo vencido sí.
    await t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_policy SET max_pending_touches = 1 WHERE workspace_id = $1`, [WS_A]));
    await t.admin(`
      INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for) VALUES
        ('${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', 'email', 'a', 'scheduled', now() + interval '3 days'),
        ('${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', 'email', 'b', 'scheduled', now() + interval '4 days');
    `);
    assert.equal(await pausa(WS_A), false, 'tres en cola para más adelante no son un atasco');
    await t.admin(`UPDATE outbound_touch SET scheduled_for = now() - interval '1 hour'
                    WHERE workspace_id = '${WS_A}' AND status = 'scheduled'`);
    assert.equal(await pausa(WS_A), true, 'tres vencidos sin salir, con tope 1: se para');

    const cancelados = await t.db.withWorkspace(WS_A, (tx) => disableOutreach(tx, 'Revisión de la cuenta'));
    assert.equal(cancelados, 3);
    assert.equal(await pausa(WS_A), true);
    const otro = await toque(TOUCH_OTRO);
    assert.deepEqual([otro.status, otro.blocked_reason], ['canceled', 'outreach_disabled']);
    const [enr] = await sinRls<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = '${ENR_A}'`);
    assert.equal(enr?.status, 'opted_out', 'apagar no toca los enrolamientos');
  });

  test('desde otro workspace no se apaga ni se enciende el de A', async () => {
    // El envoltorio ni lo intenta: con un WorkspaceTx, el workspace es el de la transacción.
    await assert.rejects(t.db.withWorkspace(WS_B, (tx) => disableOutreach(tx, 'sabotaje', WS_A)), /es del workspace/);
    // Y a pelo, la base tampoco: en PGlite salta la referencia visible
    // (0025); en Postgres, antes, la política de la fila nueva.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query(`SELECT disable_outreach('${WS_A}', 'sabotaje')`)),
      /no puede ver|row-level security/,
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

  test('outbound_health devuelve la salud en jsonb: personas dadas de baja, fallos por hora de cambio y gasto de todas las llamadas', async () => {
    // Sola pulsa el enlace de su único correo: no le quedaba nada pendiente.
    assert.equal((await baja(TOKEN_SOLA)).r.status, 'ok');
    // Tres llamadas al modelo hoy; la revisión del juez es su detalle y no se suma dos veces.
    await t.db.withWorkspace(WS_A, async (tx) => {
      await tx.query(
        `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, touch_id) VALUES
           ($1, 'generate', 'claude-sonnet-5', 1200, 300, 0.012, $2),
           ($1, 'judge', 'claude-sonnet-5', 900, 120, 0.0075, $2),
           ($1, 'classify', 'claude-haiku-4-5-20251001', 400, 10, 0.0004, NULL)`,
        [WS_A, TOUCH_SENT],
      );
      await tx.query(
        `INSERT INTO outbound_review (workspace_id, touch_id, attempt, body, decision, model, cost)
         VALUES ($1, $2, 1, 'Hola', 'pass', 'claude-sonnet-5', 0.0075)`,
        [WS_A, TOUCH_SENT],
      );
    });

    const salud = (ws: string) => t.db.withWorkspace(ws, (tx) => outboundHealth(tx, 72));
    const h = await salud(WS_A);
    // El worker la lee igual, nombrando el workspace.
    assert.deepEqual(
      { ...(await t.db.asWorker((tx) => outboundHealth(tx, 72, WS_A))), since: h.since },
      h,
      'la misma salud desde el worker',
    );
    assert.equal(h.enabled, false);
    assert.equal(h.disabledReason, 'Revisión de la cuenta');
    assert.equal(h.shouldPause, true);
    assert.equal(h.hours, 72);
    assert.deepEqual(h.queue, { draft: 0, scheduled: 0, due: 0, processing: 0, stuck: 0, held: 0 });
    assert.equal(h.window.sent, 3, 'TOUCH_SENT, TOUCH_SIN_ID y TOUCH_SOLA');
    assert.equal(h.window.failed, 0, 'el fallo de hace un mes no vuelve a la ventana por anotarle opened_at hoy');
    assert.equal(h.window.optedOut, 2, 'dos PERSONAS: Marta (con un pendiente cancelado) y Sola (sin nada pendiente)');
    assert.equal(h.window.sentAfterOptOut, 0);
    assert.deepEqual(h.llm, { spentToday: 0.0199, dailyCap: 5, currency: 'USD' });

    const hb = await salud(WS_B);
    assert.equal(hb.window.optedOut, 2, 'Marta y la ficha propia de B que pulsó su enlace (el sabotaje de arriba)');
    assert.equal(hb.window.sentAfterOptOut, 1, 'el que salió con la baja recién puesta');
    assert.deepEqual(hb.byChannel, { email: { sent: 1, failed: 0 } });
  });

  test('outboundHealth y publicOptout comprueban la forma del jsonb antes de devolverlo', async () => {
    const buena = await t.db.withWorkspace(WS_A, (tx) => outboundHealth(tx, 24));
    assert.equal(parseOutboundHealth(JSON.parse(JSON.stringify(buena))).hours, 24);
    const rota = (cambio: Record<string, unknown>) => parseOutboundHealth({ ...buena, ...cambio });
    assert.throws(() => rota({ queue: { ...buena.queue, held: '0' } }), (e) => e instanceof OutreachShapeError && e.path === '$.queue.held');
    assert.throws(() => rota({ enabled: undefined }), (e) => e instanceof OutreachShapeError && e.path === '$.enabled');
    assert.throws(() => rota({ byChannel: { fax: { sent: 1, failed: 0 } } }), /canal desconocido/);
    assert.throws(() => rota({ breakersOpen: ['telepatia'] }), /breakersOpen/);
    assert.throws(() => rota({ llm: { ...buena.llm, currency: 'COP' } }), /currency/);
    assert.throws(() => parsePublicOptout({ status: 'quizas' }), /estado desconocido/);
    assert.throws(() => parsePublicOptout({ status: 'ok', alreadyOptedOut: false, workspaceId: 'x', touchId: TOUCH_SENT }), OutreachShapeError);
    for (const horas of [0, 721, 1.5]) {
      await assert.rejects(t.db.withWorkspace(WS_A, (tx) => outboundHealth(tx, horas)), RangeError, String(horas));
    }
    await assert.rejects(t.db.asWorker((tx) => shouldPauseOutreach(tx as never)), /hay que decir el workspace/);
  });

  test('las llamadas al modelo son una bitácora: la web las anota y no las borra', async (ctx) => {
    if (!soloEmbebido()) return ctx.skip('los GRANT de mc_app se miden en PGlite: en el CI el rol hereda los de mc_worker');
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`DELETE FROM outbound_llm_call WHERE workspace_id = $1`, [WS_A])),
      /permission denied/,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_llm_call SET cost = 0 WHERE workspace_id = $1`, [WS_A])),
      /permission denied/,
    );
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
      const d = await t.db.asWorker((tx) => nextBusinessDay(tx, new Date(ts), tz));
      assert.equal(d.toISOString(), esperado, `${ts} ${tz}`);
    }
    await assert.rejects(t.db.asWorker((tx) => nextBusinessDay(tx, new Date(), 'Bogota')), /time zone/);
  });
});
