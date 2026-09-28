/**
 * VEN-9 · la migración de outreach (0046) en Postgres embebido.
 *
 *   · los catálogos que trae: seis ángulos, la rúbrica por defecto (con
 *     pesos que la base comprueba) y la plantilla «Marca con campaña
 *     activa»; active como sombra de status en la secuencia; Gmail en
 *     minúsculas;
 *   · increment_if_under_cap e increment_weekly: dos llamadas a la vez con
 *     una plaza libre dan un true y un false, nunca dos true; por cuenta,
 *     cada cuenta tiene su plaza;
 *   · public_optout: la baja desde el enlace cruza workspaces, anota la
 *     supresión global y el clic (quién la provocó), y no deja nada
 *     pendiente; el token que no salió, o uno inventado, no encuentra
 *     nada; un workspace no puede fabricarse un enlace ni un toque
 *     «enviado», ni mover uno enviado de verdad a otra ficha, ni
 *     cambiarle el correo a la ficha para dar de baja a otra persona (se
 *     suprime la dirección del envío); y el enlace funciona aunque la
 *     ficha, el toque o la empresa se hayan borrado, o el toque se haya
 *     intentado devolver a la cola;
 *   · las cuentas de canal: una fila pendiente no ocupa el buzón de
 *     nadie, y solo el callback del proveedor la autentica;
 *   · la coherencia entre toque, enrolamiento, paso y secuencia, también
 *     para el worker; la lista global en la regla de la baja, por la
 *     dirección real del envío; y el tope de gasto en el modelo, que no
 *     cambia el workspace;
 *   · la regla de la baja en las transiciones: tras la baja se sigue
 *     anotando la respuesta, lo que estaba saliendo se registra, y no se
 *     enrola ni se reanuda a quien la pidió; un paso tiene un solo toque
 *     vivo, contando el retenido (held);
 *   · el interruptor (disable/enable/should_pause), la salud y los días
 *     hábiles, todo por los envoltorios de queries/outreach.ts, que
 *     además comprueban la forma del jsonb.
 *
 * CONCURRENCIA. PGlite serializa las transacciones (test/pglite.ts), así
 * que aquí los Promise.all de los límites no se pisan de verdad: pasarían
 * igual con una función que leyera y luego escribiera. La garantía real
 * (la segunda llamada ESPERA el bloqueo de la fila y ve la plaza gastada)
 * la prueba «el bloqueo es de verdad», que solo corre contra Postgres. El
 * job contra-postgres-real del CI la corre en cada PR, con @mc/db entero,
 * y un rojo tumba el job (CIM-2c). En local, el mismo
 * montaje (db/montaje-postgres-real.sql antes de migrar) con Docker o
 * con cualquier Postgres 16: packages/db/README.md, «Contra Postgres
 * real, en local». Contra una base que se queda, el archivo se lleva lo
 * suyo al terminar y se puede volver a correr.
 *
 * Sin red y sin seeds: cada escenario se siembra como superusuario
 * (admin) y se ejercita con el rol de verdad (mc_app en withWorkspace o
 * withPublicShare, mc_worker en asWorker).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PublicShareTx, WorkerTx, WorkspaceTx } from '../src/client.ts';
import {
  disableOutreach, enableOutreach, incrementIfUnderCap, incrementWeekly, nextBusinessDay, outboundHealth,
  OutreachShapeError, parseOutboundHealth, parsePublicOptout, publicOptout, shouldPauseOutreach,
} from '../src/queries/outreach.ts';
import {
  CHANNEL_CAP_LIMITS, DEFAULT_LLM_DAILY_CAP_USD, OUTREACH_FUNCTIONS, PERSONAL_EMAIL_CAP_LIMITS,
  WORKER_ONLY_CHANNEL_ACCOUNT_COLUMNS, WORKER_ONLY_TOUCH_COLUMNS, WORKER_ONLY_TOUCH_STATUS,
} from '../src/schema/outreach.ts';
import { channelCapLimits } from '../src/queries/canales.ts';
import { CANCELABLE_TOUCH_STATUSES, LIVE_TOUCH_STATUSES } from '../src/schema/ventas.ts';
import { openTestDb, type TestDb, SETUP_TIMEOUT } from './pglite.ts';

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

/**
 * Un tercer workspace para lo que ensucia la cola o la lista global
 * (borrados, rebotes, coherencia): así la salud de A y B no cambia.
 */
const WS_C = '00000037-0000-4000-8000-00000000000c';
/** Empresa propia de C: borrarla arrastra sus toques en cascada. */
const COMPANY_C = '00000037-0000-4000-8000-0000000000c3';

const TOKEN = 'k2Jd8sQ0pX4vN7bW1eR5tY9uI3oP6aS0';
const TOKEN_SIN_ID = 'sin-id-del-proveedor-0000000000001';
const TOKEN_SOLA = 'z9Yx8Wv7Ut6Sr5Qp4On3Ml2Kj1Ih0Gf9';
const TOKEN_YO_B = 'yo-b-1234567890-abcdefghijklmnopq';
const TOKEN_BORRADA = 'borrada-0987654321-zyxwvutsrqponm';
/** El enlace que el despachador escribió al reclamar TOUCH_EN_VUELO, antes de llamar al proveedor. */
const TOKEN_EN_VUELO = 'en-vuelo-5555555555-abcdefghijklm';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Los tokens con enlace de los workspaces A y B (los de C se reconocen por su dirección). */
const TOKENS_DE_ESTE_ARCHIVO = [TOKEN, TOKEN_SOLA, TOKEN_YO_B, TOKEN_BORRADA, TOKEN_EN_VUELO];

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
                                status, scheduled_for, sent_at, claimed_at, provider_message_id,
                                recipient_address, attempt_count) VALUES
      ('${TOUCH_SENT}', '${WS_A}', '${COMPANY}', '${CONTACT_A}', '${ENR_A}', '${STEP_A1}', 'email', 'Hola',
       'sent', now() - interval '2 days', now() - interval '2 days', NULL, 'gmail-0001', 'marta@cafe.test', 1),
      ('${TOUCH_PENDING_A}', '${WS_A}', '${COMPANY}', '${CONTACT_A}', '${ENR_A}', '${STEP_A2}', 'email', 'Sigo',
       'scheduled', now() + interval '2 days', NULL, NULL, NULL, NULL, 0),
      ('${TOUCH_PENDING_B}', '${WS_B}', '${COMPANY}', '${CONTACT_B}', '${ENR_B}', '${STEP_B1}', 'email', 'Hola',
       'scheduled', now() + interval '1 day', NULL, NULL, NULL, NULL, 0),
      -- Reclamado: el despachador escribió la dirección al reclamarlo (CHECK).
      ('${TOUCH_EN_VUELO}', '${WS_B}', '${COMPANY}', '${CONTACT_B}', NULL, NULL, 'email', 'Hola otra vez',
       'processing', now() - interval '1 minute', NULL, now() - interval '30 seconds', NULL, 'marta@cafe.test', 1),
      ('${TOUCH_OTRO}', '${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', NULL, NULL, 'email', 'Hola',
       'scheduled', now() + interval '1 day', NULL, NULL, NULL, NULL, 0),
      ('${TOUCH_SIN_ID}', '${WS_A}', '${COMPANY}', '${CONTACT_VICTIMA}', NULL, NULL, 'email', 'Hola',
       'sent', now() - interval '1 day', now() - interval '1 day', NULL, NULL, 'victima@cafe.test', 1),
      ('${TOUCH_SOLA}', '${WS_A}', '${COMPANY}', '${CONTACT_SOLA}', NULL, NULL, 'email', 'Hola',
       'sent', now() - interval '1 day', now() - interval '1 day', NULL, 'gmail-0002', 'sola@cafe.test', 1),
      -- Enviados hace cinco días: fuera de la ventana de 72 h de la salud.
      ('${TOUCH_YO_B}', '${WS_B}', '${COMPANY}', '${CONTACT_YO_B}', NULL, NULL, 'email', 'Prueba',
       'sent', now() - interval '5 days', now() - interval '5 days', NULL, 'gmail-b-0003', 'yo@outreach-b.test', 1),
      ('${TOUCH_BORRADA}', '${WS_A}', '${COMPANY}', '${CONTACT_BORRADA}', NULL, NULL, 'email', 'Hola',
       'sent', now() - interval '5 days', now() - interval '5 days', NULL, 'gmail-0003', 'borrada@cafe.test', 1),
      ('${TOUCH_BORRADA_B}', '${WS_B}', '${COMPANY}', '${CONTACT_BORRADA_B}', NULL, NULL, 'email', 'Hola',
       'scheduled', now() + interval '6 days', NULL, NULL, NULL, NULL, 0);
    -- Los enlaces de baja de lo que salió de verdad (admin hace de
    -- despachador). TOUCH_SIN_ID no tiene: sin id del proveedor no salió.
    -- El de TOUCH_EN_VUELO se escribió al reclamarlo y todavía no tiene
    -- sent_at: sin él, el reclamo no se confirma (4.5).
    INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, claimed_at,
                                      sent_at) VALUES
      ('${sha256(TOKEN)}', '${WS_A}', '${TOUCH_SENT}', '${CONTACT_A}', 'marta@cafe.test', now() - interval '2 days',
       now() - interval '2 days'),
      ('${sha256(TOKEN_SOLA)}', '${WS_A}', '${TOUCH_SOLA}', '${CONTACT_SOLA}', 'sola@cafe.test', now() - interval '1 day',
       now() - interval '1 day'),
      ('${sha256(TOKEN_YO_B)}', '${WS_B}', '${TOUCH_YO_B}', '${CONTACT_YO_B}', 'yo@outreach-b.test',
       now() - interval '5 days', now() - interval '5 days'),
      ('${sha256(TOKEN_BORRADA)}', '${WS_A}', '${TOUCH_BORRADA}', '${CONTACT_BORRADA}', 'borrada@cafe.test',
       now() - interval '5 days', now() - interval '5 days'),
      ('${sha256(TOKEN_EN_VUELO)}', '${WS_B}', '${TOUCH_EN_VUELO}', '${CONTACT_B}', 'marta@cafe.test',
       now() - interval '30 seconds', NULL);
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, status_changed_at, created_at)
    VALUES ('${TOUCH_FALLIDO}', '${WS_A}', '${COMPANY}', '${CONTACT_OTRO}', 'email', 'Hola', 'failed',
            now() - interval '30 days', now() - interval '31 days');
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status) VALUES
      ('${ACC_A1}', '${WS_A}', 'linkedin', 'unipile', 'unipile-A1', 'connected'),
      ('${ACC_A2}', '${WS_A}', 'linkedin', 'unipile', 'unipile-A2', 'connected'),
      ('${ACC_B1}', '${WS_B}', 'linkedin', 'unipile', 'unipile-B1', 'connected');
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_C}', 'outreach-c', 'Outreach C', 'America/Mexico_City');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_C}', 'Empresa de C', '${WS_C}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_C}', '${COMPANY_C}');
    -- Desde 0055 §8 (VEN-15) la baja por enlace vale para el workspace
    -- que envió ese correo, en todos sus canales, y nunca para toda la
    -- plataforma: estas pruebas miden eso. Lo que ve la página y el
    -- sabotaje entre inquilinos se prueban en entregabilidad.test.ts.
  `);
}, SETUP_TIMEOUT);

after(async () => {
  // Contra un Postgres que se queda (TEST_DATABASE_URL), la prueba se
  // puede volver a correr: se lleva lo suyo. Los workspaces arrastran
  // fichas, toques y contadores; la empresa compartida y la lista global,
  // no.
  if (t.kind === 'postgres') {
    await t.admin(`
      DELETE FROM workspace WHERE id IN ('${WS_A}', '${WS_B}', '${WS_C}');
      DELETE FROM company WHERE id IN ('${COMPANY}', '${COMPANY_B}', '${COMPANY_C}');
      -- Los enlaces y los clics no se van con el workspace (SET NULL, a propósito): se borran por su token.
      DELETE FROM outbound_optout_link WHERE token_hash = ANY ('{${TOKENS_DE_ESTE_ARCHIVO.map(sha256).join(',')}}')
         OR recipient_address::text LIKE '%@c.outreach.test';
      DELETE FROM outbound_optout_event WHERE token_hash = ANY ('{${TOKENS_DE_ESTE_ARCHIVO.map(sha256).join(',')}}')
         OR recipient_address::text LIKE '%@c.outreach.test';
      DELETE FROM contact_suppression WHERE email IN
        ('marta@cafe.test', 'sola@cafe.test', 'yo@outreach-b.test', 'borrada@cafe.test')
         OR email::text LIKE '%@c.outreach.test';
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

describe('0046 · catálogos', () => {
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
    // Conectar es del callback del proveedor, que corre con asWorker.
    const conectar = (ws: string, direccion: string) =>
      t.db.asWorker((tx) =>
        tx.query(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
           VALUES ($1, 'email', 'gmail_oauth', $2, 'connected') RETURNING id`,
          [ws, direccion],
        ),
      );
    const { id } = (await conectar(WS_A, 'creador@gmail.com')).rows[0] as { id: string };
    // Dos filas vivas del mismo buzón serían dos contadores y el doble de envíos.
    await assert.rejects(conectar(WS_B, 'creador@gmail.com'), /outreach_channel_account_live_idx/);
    // Lo mismo con una cuenta de Unipile.
    await assert.rejects(
      t.db.asWorker((tx) =>
        tx.query(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
           VALUES ($1, 'linkedin', 'unipile', 'unipile-A1', 'connected')`,
          [WS_B],
        ),
      ),
      /outreach_channel_account_live_idx/,
    );
    // Desconectado en A (la persona lo desconecta desde la web), B lo puede conectar.
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query(`UPDATE outreach_channel_account SET status = 'disconnected' WHERE id = $1`, [id]),
    );
    await conectar(WS_B, 'creador@gmail.com');
  });

  test('una fila pendiente no ocupa el buzón de nadie, y solo el callback del proveedor la autentica', async () => {
    const soloElCallback = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /la autentica el callback del proveedor/.test(e.message ?? '');
    const b = (sql: string, params: unknown[]) => t.db.withWorkspace(WS_B, (tx) => tx.query(sql, params));

    // B «reserva» el Gmail de Laura con una fila pendiente, que la web sí puede crear…
    const { id: pendiente } = (
      await b(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id)
         VALUES ($1, 'email', 'gmail_oauth', 'laura.real@gmail.com') RETURNING id`,
        [WS_B],
      )
    ).rows[0] as { id: string };
    // …y no le sirve: Laura conecta su Gmail en A por el OAuth.
    await t.db.asWorker((tx) =>
      tx.query(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status, scopes)
         VALUES ($1, 'email', 'gmail_oauth', 'laura.real@gmail.com', 'connected', '{gmail.send}')`,
        [WS_A],
      ),
    );

    // Desde la web, B no se autentica sola: ni al crear ni al cambiar.
    assert.deepEqual([...WORKER_ONLY_CHANNEL_ACCOUNT_COLUMNS], [
      'status', 'provider_account_id', 'secret_ref', 'scopes', 'channel', 'provider', 'warmup_started_at', 'last_ok_at',
    ]);
    for (const status of ['connected', 'needs_reconnect', 'error']) {
      await assert.rejects(
        b(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
           VALUES ($1, 'linkedin', 'unipile', $2, $3)`,
          [WS_B, `unipile-falso-${status}`, status],
        ),
        soloElCallback,
        status,
      );
      await assert.rejects(b(`UPDATE outreach_channel_account SET status = $1 WHERE id = $2`, [status, pendiente]), soloElCallback);
    }
    await assert.rejects(
      b(`UPDATE outreach_channel_account SET provider_account_id = 'otra@gmail.com' WHERE id = $1`, [pendiente]),
      soloElCallback,
    );
    await assert.rejects(b(`UPDATE outreach_channel_account SET scopes = '{gmail.send}' WHERE id = $1`, [pendiente]), soloElCallback);
    await assert.rejects(
      b(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, scopes)
         VALUES ($1, 'linkedin', 'unipile', 'unipile-con-scopes', '{x}')`,
        [WS_B],
      ),
      soloElCallback,
    );
    // Lo que sí es de la persona: el nombre, sus topes y desconectar.
    await b(
      `UPDATE outreach_channel_account SET display_name = 'Mi Gmail', daily_cap = 20, status = 'disconnected' WHERE id = $1`,
      [pendiente],
    );
    const [fila] = await sinRls<{ status: string; provider_account_id: string }>(
      `SELECT status, provider_account_id FROM outreach_channel_account WHERE id = '${pendiente}'`,
    );
    assert.deepEqual({ ...fila }, { status: 'disconnected', provider_account_id: 'laura.real@gmail.com' });
  });

  test('sabotaje: una cuenta conectada no cambia de canal, de calentamiento ni se borra desde la web', async () => {
    const soloElCallback = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /la autentica el callback del proveedor/.test(e.message ?? '');
    const noSeBorra = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /no se borra desde la aplicación/.test(e.message ?? '');
    const b = (sql: string, params: unknown[] = []) => t.db.withWorkspace(WS_B, (tx) => tx.query(sql, params));
    // El callback conecta el Gmail de B, y el despachador gasta sus dos plazas de hoy.
    const { id: gmail } = (
      await t.db.asWorker((tx) =>
        tx.query(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status,
                                                 warmup_started_at, last_ok_at)
           VALUES ($1, 'email', 'gmail_oauth', 'buzon.b@gmail.com', 'connected', now(), now()) RETURNING id`,
          [WS_B],
        ),
      )
    ).rows[0] as { id: string };
    const plaza = () =>
      t.db.asWorker((tx) => incrementIfUnderCap(tx, { workspaceId: WS_B, accountId: gmail, actionType: 'email', cap: 2 }));
    assert.deepEqual([await plaza(), await plaza(), await plaza()], [true, true, false]);

    // La identidad: un Gmail conectado no se reescribe como LinkedIn (saldría del índice global).
    await assert.rejects(
      b(`UPDATE outreach_channel_account SET channel = 'linkedin', provider = 'unipile' WHERE id = $1`, [gmail]),
      soloElCallback,
    );
    // El calentamiento y la última respuesta buena son del proveedor.
    await assert.rejects(
      b(`UPDATE outreach_channel_account SET warmup_started_at = now() - interval '400 days' WHERE id = $1`, [gmail]),
      soloElCallback,
    );
    await assert.rejects(b(`UPDATE outreach_channel_account SET last_ok_at = now() WHERE id = $1`, [gmail]), soloElCallback);
    await assert.rejects(
      b(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, warmup_started_at)
         VALUES ($1, 'linkedin', 'unipile', 'unipile-calentada', now() - interval '5 years')`,
        [WS_B],
      ),
      soloElCallback,
    );
    // Volver a 'pending' la dejaría borrable: tampoco.
    await assert.rejects(b(`UPDATE outreach_channel_account SET status = 'pending' WHERE id = $1`, [gmail]), soloElCallback);
    // Borrarla y reconectar devolvería las plazas de hoy: no se borra, ni conectada ni desconectada.
    await assert.rejects(b(`DELETE FROM outreach_channel_account WHERE id = $1`, [gmail]), noSeBorra);
    await b(`UPDATE outreach_channel_account SET status = 'disconnected' WHERE id = $1`, [gmail]);
    await assert.rejects(b(`DELETE FROM outreach_channel_account WHERE id = $1`, [gmail]), noSeBorra);
    const [contador] = await sinRls<{ count: number }>(
      `SELECT count FROM outbound_counter WHERE channel_account_id = '${gmail}' AND period = 'day'`,
    );
    assert.equal(contador?.count, 2, 'el contador del día sigue');
    // Lo que sí: el motivo de un intento, y borrar la fila pendiente de un intento que no terminó.
    await b(`UPDATE outreach_channel_account SET last_error = 'oauth_denied', last_error_at = now() WHERE id = $1`, [gmail]);
    const { id: intento } = (
      await b(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id)
         VALUES ($1, 'linkedin', 'unipile', 'pending:intento-borrable') RETURNING id`,
        [WS_B],
      )
    ).rows[0] as { id: string };
    await b(`DELETE FROM outreach_channel_account WHERE id = $1`, [intento]);
  });
});

describe('0046 · límites atómicos', () => {
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
      return ctx.skip('PGlite serializa las transacciones; con TEST_DATABASE_URL (ver la cabecera) sí corre');
    }
    await bloqueoDeVerdad('increment_if_under_cap', 'email_real', null);
    await bloqueoDeVerdad('increment_weekly', 'email_real', null);
    await bloqueoDeVerdad('increment_if_under_cap', 'linkedin_real', ACC_A1);
    await bloqueoDeVerdad('increment_weekly', 'linkedin_real', ACC_A1);
  });
});

describe('0046 · public_optout, la baja desde el enlace', () => {
  test('un token inventado, corto, o de un correo que no dejó enlace no encuentra nada', async () => {
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
    // Y los enlaces no los lee nadie desde la web: sin privilegio (en PGlite
    // y contra Postgres real, donde la sesión es mc_app desde CIM-2c r6).
    const enlaces = await t.db
      .withWorkspace(WS_B, async (tx) => {
        await tx.query("SELECT set_config('app.public_optout', $1, true)", [sha256(TOKEN)]);
        // El de A (el de B, en el CI, lo ve su propio workspace).
        return (await tx.query('SELECT token_hash FROM outbound_optout_link WHERE token_hash = $1', [sha256(TOKEN)])).rows
          .length;
      })
      .catch((e: { message?: string }) => (/permission denied/.test(e.message ?? '') ? 0 : Promise.reject(e)));
    assert.equal(enlaces, 0);
  });

  test('sabotaje: un workspace no se fabrica un toque «enviado» para dar de baja el correo de otra persona', async () => {
    const TOKEN_FALSO = 'token-inventado-por-el-workspace-b-0001';
    const sabotaje = (sql: string, params: unknown[] = []) => t.db.withWorkspace(WS_B, (tx) => tx.query(sql, params));
    const soloElDespachador = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /los escribe solo el despachador/.test(e.message ?? '');

    // Un enlace propio no se escribe: la tabla es del despachador (a mc_app le
    // falta el privilegio, y tampoco hay ninguna política que deje escribir).
    await assert.rejects(
      sabotaje(
        `INSERT INTO outbound_optout_link (token_hash, workspace_id, contact_id, recipient_address, sent_at)
         VALUES ($1, $2, $3, 'victima@cafe.test', now())`,
        [sha256(TOKEN_FALSO), WS_B, CONTACT_SABOTAJE],
      ),
      /permission denied|row-level security/,
    );

    // Ni un toque con las pruebas de envío: el alta con un id de proveedor no entra.
    for (const [columna, valor] of [
      ['provider_message_id', 'gmail-falso'],
      ['message_id_rfc', '<falso@mail.gmail.com>'],
      ['recipient_address', 'victima@cafe.test'],
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
      const valor = columna === 'recipient_address' ? 'victima@cafe.test' : 'falso';
      await assert.rejects(sabotaje(`UPDATE outbound_touch SET ${columna} = $1 WHERE id = $2`, [valor, id]), soloElDespachador, columna);
    }
    assert.deepEqual((await baja(TOKEN_FALSO)).r, { status: 'not_found' });

    // Y la víctima sigue igual en todas partes.
    const fichas = await sinRls<{ opted_out: boolean }>(
      `SELECT opted_out FROM contact WHERE id IN ('${CONTACT_VICTIMA}', '${CONTACT_SABOTAJE}')`,
    );
    assert.deepEqual(fichas.map((f) => f.opted_out), [false, false]);
    assert.deepEqual(await sinRls("SELECT 1 FROM contact_suppression WHERE email = 'victima@cafe.test'"), []);

    // El despachador sí escribe esas columnas: son suyas (con la dirección, que el CHECK pide).
    await t.db.asWorker((tx) =>
      tx.query(
        `UPDATE outbound_touch SET provider_message_id = 'gmail-b-0001', message_id_rfc = '<b1@mail>',
                recipient_address = 'victima@cafe.test' WHERE id = $1`,
        [id],
      ),
    );
    await t.admin(`DELETE FROM outbound_touch WHERE id = '${id}'`);
  });

  test('marca la baja en la ficha de quien envió y cancela lo suyo; otro workspace sigue igual hasta que su enlace se pulse', async () => {
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
        // La ficha de B con la misma dirección no es de A: un enlace de A no la toca (0055 §8).
        [CONTACT_B, false, false],
      ],
    );

    const esperado: Record<string, [string, string | null]> = {
      [TOUCH_SENT]: ['sent', null],
      [TOUCH_PENDING_A]: ['canceled', 'opted_out'],
      [TOUCH_PENDING_B]: ['scheduled', null],
      [TOUCH_OTRO]: ['scheduled', null],
      // Lo reclamado es del despachador: la baja no lo toca (0046 §4.1).
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
        [ENR_B, 'active', false],
      ],
      'la baja termina los enrolamientos de quien envió y dice cuándo',
    );

    // Un enlace nunca escribe la lista de toda la plataforma (0055 §8); sí la del workspace que envió.
    assert.deepEqual(await sinRls("SELECT 1 FROM contact_suppression WHERE email = 'marta@cafe.test'"), []);
    const listas = await sinRls<{ workspace_id: string }>(
      "SELECT workspace_id FROM outbound_workspace_optout WHERE email = 'marta@cafe.test'",
    );
    assert.deepEqual(listas.map((x) => x.workspace_id), [WS_A]);

    // Y queda quién la provocó: el workspace y el toque del correo.
    const clics = await sinRls<{ workspace_id: string; touch_id: string; already_opted_out: boolean }>(
      `SELECT workspace_id, touch_id, already_opted_out FROM outbound_optout_event WHERE token_hash = '${sha256(TOKEN)}'`,
    );
    assert.deepEqual(clics.map((c) => ({ ...c })), [{ workspace_id: WS_A, touch_id: TOUCH_SENT, already_opted_out: false }]);

    // Cancela exactamente CANCELABLE_TOUCH_STATUSES: todo lo vivo menos processing.
    assert.deepEqual(
      LIVE_TOUCH_STATUSES.filter((x) => !(CANCELABLE_TOUCH_STATUSES as readonly string[]).includes(x)),
      ['processing'],
    );
    const [def] = await sinRls<{ d: string }>("SELECT pg_get_functiondef('public_optout(text)'::regprocedure) AS d");
    assert.ok(
      def!.d.includes(`status IN (${CANCELABLE_TOUCH_STATUSES.map((x) => `'${x}'`).join(', ')})`),
      'public_optout cancela los estados de CANCELABLE_TOUCH_STATUSES',
    );

    // Marta pulsa también el enlace del correo de B (el que el despachador
    // tiene en vuelo): ahora B tampoco le escribe. Lo reclamado sigue siendo
    // del despachador; las pruebas de las transiciones parten de aquí.
    assert.deepEqual((await baja(TOKEN_EN_VUELO)).r, {
      status: 'ok', alreadyOptedOut: false, workspaceId: WS_B, touchId: TOUCH_EN_VUELO,
    });
    const [enB] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_B}'`);
    assert.equal(enB?.opted_out, true);
    assert.deepEqual([(await toque(TOUCH_PENDING_B)).status, (await toque(TOUCH_EN_VUELO)).status], ['canceled', 'processing']);
    assert.deepEqual(await sinRls("SELECT 1 FROM contact_suppression WHERE email = 'marta@cafe.test'"), []);
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
    // Se da de baja la dirección a la que salió el correo, no la de hoy.
    const lista = await sinRls<{ email: string }>(
      `SELECT email::text AS email FROM outbound_workspace_optout
        WHERE workspace_id = '${WS_B}' AND email IN ('yo@outreach-b.test', 'otra@cafe.test')`,
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
    assert.deepEqual(await sinRls("SELECT 1 FROM outbound_workspace_optout WHERE email = 'otra@cafe.test'"), []);
  });

  test('el enlace sigue funcionando si el workspace borró la ficha después del envío', async () => {
    await t.db.withWorkspace(WS_A, (tx) => tx.query('DELETE FROM contact WHERE id = $1', [CONTACT_BORRADA]));
    const [huerfano] = await sinRls<{ contact_id: string | null }>(
      `SELECT contact_id FROM outbound_touch WHERE id = '${TOUCH_BORRADA}'`,
    );
    assert.equal(huerfano?.contact_id, null, 'la clave ajena lo pone a NULL y el candado lo deja');

    const { r } = await baja(TOKEN_BORRADA);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_A, touchId: TOUCH_BORRADA });
    // A ya no le escribe a esa dirección, aunque no quede ficha.
    assert.equal(
      (await sinRls(`SELECT 1 FROM outbound_workspace_optout WHERE workspace_id = '${WS_A}' AND email = 'borrada@cafe.test'`)).length,
      1,
    );
    // La misma persona en B: B no envió ese correo, así que lo suyo sigue (0055 §8).
    const [enB] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_BORRADA_B}'`);
    assert.equal(enB?.opted_out, false);
    assert.equal((await toque(TOUCH_BORRADA_B)).status, 'scheduled');
    assert.deepEqual(await sinRls("SELECT 1 FROM contact_suppression WHERE email = 'borrada@cafe.test'"), []);
  });

  describe('el enlace no depende de la cola (C)', () => {
    /** Tres correos que C envió de verdad, cada uno con su enlace. */
    const C1 = '00000037-0000-4000-8000-0000000000c5';
    const C2 = '00000037-0000-4000-8000-0000000000c6';
    const C3 = '00000037-0000-4000-8000-0000000000c7';
    const T1 = '00000037-0000-4000-8000-0000000070c1';
    const T2 = '00000037-0000-4000-8000-0000000070c2';
    const T3 = '00000037-0000-4000-8000-0000000070c3';
    const TK = { [T1]: 'c-uno-0123456789abcdefghij', [T2]: 'c-dos-0123456789abcdefghij', [T3]: 'c-tres-0123456789abcdefghi' };
    const c = (sql: string, params: unknown[] = []) => t.db.withWorkspace(WS_C, (tx) => tx.query(sql, params));
    /** C ya no le escribe a esa dirección (0055 §8): la baja del workspace que envió. */
    const suprimido = async (correo: string) =>
      (await sinRls(`SELECT 1 FROM outbound_workspace_optout WHERE workspace_id = '${WS_C}' AND email = '${correo}'`))
        .length === 1;

    before(async () => {
      await t.admin(`
        INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
          ('${C1}', '${COMPANY_C}', 'Uno', 'uno@c.outreach.test', 'user_provided', '${WS_C}'),
          ('${C2}', '${COMPANY_C}', 'Dos', 'dos@c.outreach.test', 'user_provided', '${WS_C}'),
          ('${C3}', '${COMPANY_C}', 'Tres', 'tres@c.outreach.test', 'user_provided', '${WS_C}');
      `);
      // El despachador envía: el toque con sus pruebas y el enlace, en la misma transacción.
      for (const [touch, contacto, correo] of [
        [T1, C1, 'uno@c.outreach.test'],
        [T2, C2, 'dos@c.outreach.test'],
        [T3, C3, 'tres@c.outreach.test'],
      ] as const) {
        await t.db.asWorker(async (tx) => {
          await tx.query(
            `INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, sent_at,
                                         provider_message_id, recipient_address)
             VALUES ($1, $2, $3, $4, 'email', 'Hola', 'sent', now() - interval '3 days', $5, $6)`,
            [touch, WS_C, COMPANY_C, contacto, `gmail-${touch.slice(-3)}`, correo],
          );
          await tx.query(
            `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, sent_at)
             VALUES ($1, $2, $3, $4, $5, now() - interval '3 days')`,
            [sha256(TK[touch]), WS_C, touch, contacto, correo],
          );
        });
      }
    }, SETUP_TIMEOUT);

    test('un toque enviado no vuelve a la cola desde la web, y el enlace no mira su estado', async () => {
      const noVuelve = (e: { code?: string; message?: string }) =>
        e.code === '42501' && /no vuelve atrás/.test(e.message ?? '');
      for (const status of ['draft', 'scheduled', 'failed', 'canceled']) {
        await assert.rejects(c(`UPDATE outbound_touch SET status = $1 WHERE id = $2`, [status, T1]), noVuelve, status);
      }
      assert.equal((await toque(T1)).status, 'sent');
      // Aunque alguien con más poder lo mueva (el worker puede), el enlace sigue.
      await t.db.asWorker((tx) => tx.query(`UPDATE outbound_touch SET status = 'failed' WHERE id = $1`, [T1]));
      assert.deepEqual((await baja(TK[T1])).r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_C, touchId: T1 });
      assert.ok(await suprimido('uno@c.outreach.test'));
    });

    test('un toque enviado no se borra desde la web, y si desaparece el enlace sigue', async () => {
      await assert.rejects(
        c('DELETE FROM outbound_touch WHERE id = $1', [T2]),
        (e: { code?: string; message?: string }) => e.code === '42501' && /no se borra/.test(e.message ?? ''),
      );
      // Un toque sin pruebas de envío sí se borra.
      const { id } = (
        await c(`INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body) VALUES ($1, $2, $3, 'email', 'x')
                 RETURNING id`, [WS_C, COMPANY_C, C2])
      ).rows[0] as { id: string };
      await c('DELETE FROM outbound_touch WHERE id = $1', [id]);

      await t.admin(`DELETE FROM outbound_touch WHERE id = '${T2}'`);
      assert.deepEqual((await baja(TK[T2])).r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_C, touchId: null });
      assert.ok(await suprimido('dos@c.outreach.test'));
      const [ficha] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${C2}'`);
      assert.equal(ficha?.opted_out, true, 'la ficha que recibió el correo, por el contacto del enlace');
    });

    test('borrar la empresa (que arrastra sus toques) o el workspace no rompe el enlace', async () => {
      // La web puede borrar su empresa: la cascada se lleva el toque enviado.
      await c('DELETE FROM company WHERE id = $1', [COMPANY_C]);
      assert.deepEqual(await sinRls(`SELECT 1 FROM outbound_touch WHERE id = '${T3}'`), []);
      const { r } = await baja(TK[T3]);
      assert.deepEqual(r, { status: 'ok', alreadyOptedOut: false, workspaceId: WS_C, touchId: null });
      assert.ok(await suprimido('tres@c.outreach.test'));

      // Y sin el workspace: el enlace se queda sin dueño y sigue respondiendo.
      await t.admin(`DELETE FROM workspace WHERE id = '${WS_C}'`);
      const [enlace] = await sinRls<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM outbound_optout_link WHERE token_hash = '${sha256(TK[T1])}'`,
      );
      assert.equal(enlace?.workspace_id, null);
      assert.deepEqual((await baja(TK[T1])).r, { status: 'ok', alreadyOptedOut: true, workspaceId: null, touchId: null });
      // Los clics de C siguen atribuidos a su token, sin workspace.
      const clics = await sinRls<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbound_optout_event WHERE recipient_address::text LIKE '%@c.outreach.test'`,
      );
      assert.equal(clics[0]?.n, 4);
    });

    test('el despachador no repite un token ni escribe un enlace que no concuerda con su toque', async () => {
      // Un token repetido falla al escribirlo, en vez de dar de baja a otra dirección en silencio.
      await assert.rejects(
        t.db.asWorker((tx) =>
          tx.query(
            `INSERT INTO outbound_optout_link (token_hash, recipient_address, sent_at) VALUES ($1, 'otra@x.test', now())`,
            [sha256(TOKEN)],
          ),
        ),
        /outbound_optout_link_pkey/,
      );
      // La dirección del enlace es la del toque.
      await assert.rejects(
        t.db.asWorker((tx) =>
          tx.query(
            `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, sent_at)
             VALUES ($1, $2, $3, $4, 'otra@cafe.test', now())`,
            [sha256('otro-token-de-sola-000000000001'), WS_A, TOUCH_SOLA, CONTACT_SOLA],
          ),
        ),
        /no concuerda con su toque/,
      );
    });
  });

  test('pulsar el enlace otra vez responde lo mismo y no rompe nada', async () => {
    const [antes] = await sinRls<{ f: string }>(`SELECT finished_at::text AS f FROM outbound_enrollment WHERE id = '${ENR_A}'`);
    const { r } = await baja(TOKEN);
    assert.deepEqual(r, { status: 'ok', alreadyOptedOut: true, workspaceId: WS_A, touchId: TOUCH_SENT });
    const [despues] = await sinRls<{ f: string }>(`SELECT finished_at::text AS f FROM outbound_enrollment WHERE id = '${ENR_A}'`);
    assert.equal(despues?.f, antes?.f, 'finished_at no se mueve');
  });
});

describe('0046 · la regla de la baja, en las transiciones', () => {
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
        tx.query(
          `UPDATE outbound_touch SET status = 'processing', claimed_at = now(), attempt_count = attempt_count + 1,
                  recipient_address = 'marta@cafe.test' WHERE id = $1`,
          [TOUCH_PENDING_A],
        ),
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

describe('0046 · el interruptor, la salud y los días hábiles', () => {
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
    await assert.rejects(
      // @ts-expect-error — con un WorkspaceTx no se nombra otro workspace (la firma de tres es la del worker)
      t.db.withWorkspace(WS_B, (tx) => disableOutreach(tx, 'sabotaje', WS_A)),
      /es del workspace/,
    );
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
    // B no tiene política: el tope es el valor por defecto de la columna, no 0.
    assert.equal(hb.llm.dailyCap, Number(DEFAULT_LLM_DAILY_CAP_USD));
    const [defecto] = await sinRls<{ v: string }>('SELECT outreach_default_llm_daily_cap()::text AS v');
    assert.equal(defecto?.v, DEFAULT_LLM_DAILY_CAP_USD);
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
    // Sin workspace o sin toque (se borraron), el enlace sigue valiendo.
    assert.deepEqual(parsePublicOptout({ status: 'ok', alreadyOptedOut: true, workspaceId: null, touchId: null }), {
      status: 'ok', alreadyOptedOut: true, workspaceId: null, touchId: null,
    });
    for (const horas of [0, 721, 1.5]) {
      await assert.rejects(t.db.withWorkspace(WS_A, (tx) => outboundHealth(tx, horas)), RangeError, String(horas));
    }
    await assert.rejects(t.db.asWorker((tx) => shouldPauseOutreach(tx as never)), /hay que decir el workspace/);
  });

  test('las llamadas al modelo son una bitácora: la web las anota y no las borra', async () => {
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

describe('0046 · coherencia de la cola, lista global en la regla y tope de gasto (D)', () => {
  const WS_D = '00000037-0000-4000-8000-00000000000d';
  const COMPANY_D = '00000037-0000-4000-8000-0000000000d0';
  const D1 = '00000037-0000-4000-8000-0000000000d1';
  const D2 = '00000037-0000-4000-8000-0000000000d2';
  const D3 = '00000037-0000-4000-8000-0000000000d3';
  const SEQ_D1 = '00000037-0000-4000-8000-0000000005d1';
  const SEQ_D2 = '00000037-0000-4000-8000-0000000005d2';
  const STEP_D1 = '00000037-0000-4000-8000-0000000051d1';
  const STEP_D2 = '00000037-0000-4000-8000-0000000051d2';
  const ENR_D1 = '00000037-0000-4000-8000-00000000e0d1';
  const d = (sql: string, params: unknown[] = []) => t.db.withWorkspace(WS_D, (tx) => tx.query(sql, params));
  const w = (sql: string, params: unknown[] = []) => t.db.asWorker((tx) => tx.query(sql, params));
  const incoherente = (re: RegExp) => (e: { code?: string; message?: string }) =>
    e.code === '23514' && re.test(e.message ?? '');
  const alta = (cols: Record<string, string | null>) => {
    const k = Object.keys(cols);
    return `INSERT INTO outbound_touch (${k.join(', ')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')})`;
  };
  const toqueD = (extra: Record<string, string | null>) => ({
    workspace_id: WS_D, company_id: COMPANY_D, channel: 'email', body: 'Hola', ...extra,
  });

  before(async () => {
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_D}', 'outreach-d', 'Outreach D', 'Europe/Lisbon');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_D}', 'Empresa de D', '${WS_D}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_D}', '${COMPANY_D}');
      INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
        ('${D1}', '${COMPANY_D}', 'D uno', 'd1@d.outreach.test', 'user_provided', '${WS_D}'),
        ('${D2}', '${COMPANY_D}', 'D dos', 'd2@d.outreach.test', 'user_provided', '${WS_D}'),
        ('${D3}', '${COMPANY_D}', 'D tres', 'd3@d.outreach.test', 'user_provided', '${WS_D}');
      INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES
        ('${SEQ_D1}', '${WS_D}', 'D1', 'email', 'active'), ('${SEQ_D2}', '${WS_D}', 'D2', 'email', 'active');
      INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, step_type, channel, generate_with_ai, body_template) VALUES
        ('${STEP_D1}', '${WS_D}', '${SEQ_D1}', 1, 'email', 'email', false, 'Hola'),
        ('${STEP_D2}', '${WS_D}', '${SEQ_D2}', 1, 'email', 'email', false, 'Hola');
      INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id) VALUES ('${ENR_D1}', '${WS_D}', '${SEQ_D1}', '${D1}');
    `);
  }, SETUP_TIMEOUT);

  after(async () => {
    if (t.kind === 'postgres') {
      await t.admin(`
        DELETE FROM workspace WHERE id = '${WS_D}';
        DELETE FROM company WHERE id = '${COMPANY_D}';
        DELETE FROM contact_suppression WHERE email::text LIKE '%@d.outreach.test';
        DELETE FROM outbound_optout_link WHERE recipient_address::text LIKE '%@d.outreach.test';
      `);
    }
  });

  test('un toque es del contacto, del workspace y de la secuencia de su enrolamiento, también para el worker', async () => {
    const t1 = toqueD({ contact_id: D2, enrollment_id: ENR_D1 });
    await assert.rejects(w(alta(t1), Object.values(t1)), incoherente(/su enrolamiento .* es del contacto/));
    const t2 = toqueD({ contact_id: D1, enrollment_id: ENR_D1, step_id: STEP_D2 });
    await assert.rejects(w(alta(t2), Object.values(t2)), incoherente(/es de la secuencia/));
    const t3 = toqueD({ contact_id: D1, enrollment_id: ENR_D1, step_id: STEP_A1 });
    await assert.rejects(w(alta(t3), Object.values(t3)), incoherente(/su paso .* es del workspace/));
    const t4 = toqueD({ contact_id: CONTACT_A, enrollment_id: ENR_A });
    await assert.rejects(w(alta(t4), Object.values(t4)), incoherente(/su enrolamiento .* es del workspace/));
    // Y desde la web, un toque con enrolamiento y sin contacto (el despachador tomaría el del enrolamiento).
    const t5 = toqueD({ contact_id: null, enrollment_id: ENR_D1, step_id: STEP_D1 });
    await assert.rejects(d(alta(t5), Object.values(t5)), incoherente(/no tiene contacto/));

    // Pasos y enrolamientos: el workspace de su secuencia, y el paso actual de SU secuencia.
    await assert.rejects(
      w(`INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, step_type, channel) VALUES ($1, $2, 2, 'email', 'email')`, [
        WS_D, SEQ_A,
      ]),
      incoherente(/su secuencia .* es del workspace/),
    );
    await assert.rejects(
      w(`INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id) VALUES ($1, $2, $3)`, [WS_D, SEQ_A, D2]),
      incoherente(/su secuencia .* es del workspace/),
    );
    await assert.rejects(
      w(`UPDATE outbound_enrollment SET current_step_id = $1 WHERE id = $2`, [STEP_D2, ENR_D1]),
      incoherente(/otra secuencia/),
    );

    // Lo coherente entra, y borrar la ficha (que pone a NULL el contacto del toque y borra su enrolamiento) sigue pudiéndose.
    const bien = toqueD({ contact_id: D1, enrollment_id: ENR_D1, step_id: STEP_D1 });
    await d(alta(bien), Object.values(bien));
    await d(`UPDATE outbound_enrollment SET current_step_id = $1 WHERE id = $2`, [STEP_D1, ENR_D1]);
    await d('DELETE FROM contact WHERE id = $1', [D1]);
    assert.deepEqual(await sinRls(`SELECT 1 FROM outbound_enrollment WHERE id = '${ENR_D1}'`), []);
  });

  test('la regla de la baja mira la lista global: el correo de la ficha y la dirección real del envío', async () => {
    // Un rebote y una queja que el worker anotó; la ficha de D2 existía antes y no dice nada.
    await t.admin(`
      INSERT INTO contact_suppression (email, reason) VALUES
        ('rebote@d.outreach.test', 'hard_bounce'), ('d2@d.outreach.test', 'complaint');
    `);
    const [d2] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${D2}'`);
    assert.equal(d2?.opted_out, false);
    const optOut = (e: { code?: string; message?: string }) => e.code === '23514' && /opt-out/.test(e.message ?? '');

    const { id: paraD2 } = (await d(`${alta(toqueD({ contact_id: D2 }))} RETURNING id`, [WS_D, COMPANY_D, 'email', 'Hola', D2]))
      .rows[0] as { id: string };
    await assert.rejects(d(`UPDATE outbound_touch SET status = 'scheduled' WHERE id = $1`, [paraD2]), optOut);

    const { id: paraD3 } = (
      await d(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
         VALUES ($1, $2, $3, 'email', 'Hola', 'scheduled', now()) RETURNING id`,
        [WS_D, COMPANY_D, D3],
      )
    ).rows[0] as { id: string };
    // El reclamo de verdad (4.5): la dirección, el intento y el enlace de baja de ese intento, en una transacción.
    const reclamar = (direccion: string | null) =>
      t.db.asWorker(async (tx) => {
        await tx.query(
          `UPDATE outbound_touch SET status = 'processing', claimed_at = now(), attempt_count = attempt_count + 1,
                  recipient_address = $1 WHERE id = $2`,
          [direccion, paraD3],
        );
        await tx.query(
          `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [sha256(`d3-${direccion}-0000000000000000`), WS_D, paraD3, D3, direccion],
        );
      });
    // Reclamar un correo exige decir a qué dirección sale…
    await assert.rejects(reclamar(null), /outbound_touch_email_recipient_check/);
    // …y si esa dirección está en la lista global, aunque la ficha diga otra, no sale.
    await assert.rejects(reclamar('rebote@d.outreach.test'), optOut);
    await reclamar('d3@d.outreach.test');
    // La queja llega mientras el despachador envía: lo que salió se registra, marcado.
    await t.admin(`INSERT INTO contact_suppression (email, reason) VALUES ('d3@d.outreach.test', 'complaint')`);
    await w(`UPDATE outbound_touch SET status = 'sent', sent_at = now(), provider_message_id = 'gmail-d3' WHERE id = $1`, [paraD3]);
    const x = await toque(paraD3);
    assert.deepEqual([x.status, x.blocked_reason], ['sent', 'opted_out_in_flight']);
  });

  test('llm_daily_cap_usd lo fija la plataforma: la web no se sube el techo, ni al crear la política', async () => {
    const plataforma = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /lo fija la plataforma/.test(e.message ?? '');
    await assert.rejects(
      d(`INSERT INTO outbound_policy (workspace_id, llm_daily_cap_usd) VALUES ($1, 999)`, [WS_D]),
      plataforma,
    );
    await d(`INSERT INTO outbound_policy (workspace_id) VALUES ($1)`, [WS_D]);
    await assert.rejects(d(`UPDATE outbound_policy SET llm_daily_cap_usd = 50 WHERE workspace_id = $1`, [WS_D]), plataforma);
    // Lo demás de la política sí es del workspace.
    await d(`UPDATE outbound_policy SET warmup_days = 21, postal_address = 'Rua 1, Lisboa' WHERE workspace_id = $1`, [WS_D]);
    await w(`UPDATE outbound_policy SET llm_daily_cap_usd = 20 WHERE workspace_id = $1`, [WS_D]);
    const [pol] = await sinRls<{ cap: string; defecto: string }>(
      `SELECT llm_daily_cap_usd::text AS cap, outreach_default_llm_daily_cap()::text AS defecto
         FROM outbound_policy WHERE workspace_id = '${WS_D}'`,
    );
    assert.deepEqual({ ...pol }, { cap: '20.00', defecto: DEFAULT_LLM_DAILY_CAP_USD });
  });

  test('el enlace de baja es obligatorio: la web no apaga require_optout_link; el despachador sí', async () => {
    const obligatorio = (e: { code?: string; message?: string }) =>
      e.code === '42501' && /enlace de baja es obligatorio/.test(e.message ?? '');
    await assert.rejects(d(`UPDATE outbound_policy SET require_optout_link = false WHERE workspace_id = $1`, [WS_D]), obligatorio);
    await w(`UPDATE outbound_policy SET require_optout_link = false WHERE workspace_id = $1`, [WS_D]);
    // Con el enlace apagado por un operador, la persona sigue cambiando lo suyo, y puede volver a encenderlo.
    await d(`UPDATE outbound_policy SET warmup_days = 14 WHERE workspace_id = $1`, [WS_D]);
    await d(`UPDATE outbound_policy SET require_optout_link = true WHERE workspace_id = $1`, [WS_D]);
    const [pol] = await sinRls<{ r: boolean }>(`SELECT require_optout_link AS r FROM outbound_policy WHERE workspace_id = '${WS_D}'`);
    assert.equal(pol?.r, true);
  });

  test('un toque en cola tiene hora, y al crearlo la web no elige su status_changed_at', async () => {
    const D4 = '00000037-0000-4000-8000-0000000000d4';
    await t.admin(`INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id)
                   VALUES ('${D4}', '${COMPANY_D}', 'D cuatro', 'd4@d.outreach.test', 'user_provided', '${WS_D}')`);
    await assert.rejects(
      d(alta(toqueD({ contact_id: D4, status: 'scheduled' })), [WS_D, COMPANY_D, 'email', 'Hola', D4, 'scheduled']),
      incoherente(/outbound_touch_scheduled_for_check/),
    );
    const { id } = (
      await d(`${alta(toqueD({ contact_id: D4, status: 'failed', status_changed_at: '2036-01-01T00:00:00Z' }))} RETURNING id`, [
        WS_D, COMPANY_D, 'email', 'Hola', D4, 'failed', '2036-01-01T00:00:00Z',
      ])
    ).rows[0] as { id: string };
    const [fila] = await sinRls<{ ahora: boolean }>(
      `SELECT status_changed_at BETWEEN now() - interval '1 minute' AND now() + interval '1 minute' AS ahora
         FROM outbound_touch WHERE id = '${id}'`,
    );
    assert.equal(fila?.ahora, true, 'un fallo «de 2036» no se queda diez años en la ventana de la salud');
  });

  test('el costo de una llamada al modelo va en USD, la moneda del tope', async () => {
    await assert.rejects(
      d(
        `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency)
         VALUES ($1, 'classify', 'claude-haiku-4-5-20251001', 10, 1, 3, 'EUR')`,
        [WS_D],
      ),
      (e: { code?: string }) => e.code === '23514',
    );
  });

  test('sin un canal conectado el envío no se enciende', async () => {
    await d(`UPDATE outbound_policy SET postal_address = 'Rua 1, Lisboa' WHERE workspace_id = $1`, [WS_D]);
    await assert.rejects(
      t.db.withWorkspace(WS_D, (tx) => enableOutreach(tx)),
      (e: { code?: string; message?: string }) => e.code === '23514' && /Sin un canal conectado/.test(e.message ?? ''),
    );
    await w(
      `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
       VALUES ($1, 'email', 'gmail_oauth', 'envio@d.outreach.test', 'connected')`,
      [WS_D],
    );
    await t.db.withWorkspace(WS_D, (tx) => enableOutreach(tx));
    const [pol] = await sinRls<{ enabled: boolean }>(`SELECT enabled FROM outbound_policy WHERE workspace_id = '${WS_D}'`);
    assert.equal(pol?.enabled, true);
    await t.db.withWorkspace(WS_D, (tx) => disableOutreach(tx, 'fin de la prueba'));
  });

  test('WorkerTx lleva marca: los límites no compilan con la transacción de la web ni la del enlace', () => {
    // Solo tipos: la función no se llama. Sin la marca, estas líneas
    // compilaban y fallaban en ejecución con 42501.
    const soloTipos = (ws: WorkspaceTx, ps: PublicShareTx, wk: WorkerTx) => {
      const req = { workspaceId: WS_D, actionType: 'email', cap: 1 };
      // @ts-expect-error — un WorkspaceTx no es un WorkerTx
      void incrementIfUnderCap(ws, req);
      // @ts-expect-error — un PublicShareTx tampoco
      void incrementWeekly(ps, req);
      void incrementIfUnderCap(wk, req);
    };
    assert.equal(typeof soloTipos, 'function');
  });
});

describe('0046 · techo por canal, processing del despachador, baja global al enrolar y enlace al reclamar (E)', () => {
  const WS_E = '00000037-0000-4000-8000-00000000000e';
  const COMPANY_E = '00000037-0000-4000-8000-0000000000e0';
  /** Dada de baja solo en la lista global: su ficha no lo dice. */
  const E_REBOTADA = '00000037-0000-4000-8000-0000000000e1';
  const E_LINKEDIN = '00000037-0000-4000-8000-0000000000e2';
  const E_CORREO = '00000037-0000-4000-8000-0000000000e3';
  const SEQ_E = '00000037-0000-4000-8000-0000000005e1';
  const TOKEN_E1 = 'e-intento-uno-aaaaaaaaaa-abcdefghij';
  const TOKEN_E2 = 'e-intento-dos-bbbbbbbbbb-abcdefghij';
  const e = (sql: string, params: unknown[] = []) => t.db.withWorkspace(WS_E, (tx) => tx.query(sql, params));
  const w = (sql: string, params: unknown[] = []) => t.db.asWorker((tx) => tx.query(sql, params));

  before(async () => {
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_E}', 'outreach-e', 'Outreach E', 'America/Lima');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_E}', 'Empresa de E', '${WS_E}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_E}', '${COMPANY_E}');
      INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
        ('${E_REBOTADA}', '${COMPANY_E}', 'E rebotada', 'rebotada@e.outreach.test', 'user_provided', '${WS_E}'),
        ('${E_LINKEDIN}', '${COMPANY_E}', 'E linkedin', NULL, 'user_provided', '${WS_E}'),
        ('${E_CORREO}', '${COMPANY_E}', 'E correo', 'correo@e.outreach.test', 'user_provided', '${WS_E}');
      INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES
        ('${SEQ_E}', '${WS_E}', 'E', 'email', 'active');
    `);
  }, SETUP_TIMEOUT);

  after(async () => {
    if (t.kind === 'postgres') {
      await t.admin(`
        DELETE FROM workspace WHERE id = '${WS_E}';
        DELETE FROM company WHERE id = '${COMPANY_E}';
        DELETE FROM contact_suppression WHERE email::text LIKE '%@e.outreach.test';
        DELETE FROM outbound_optout_link WHERE recipient_address::text LIKE '%@e.outreach.test';
        DELETE FROM outbound_optout_event WHERE recipient_address::text LIKE '%@e.outreach.test';
      `);
    }
  });

  test('el techo de cada canal (§5.1): ni la web ni el worker pasan de lo que el proveedor aguanta', async () => {
    const fuera = (err: { code?: string; message?: string }) =>
      err.code === '23514' && /outreach_channel_account_channel_caps_check/.test(err.message ?? '');
    for (const [canal, techo] of Object.entries(CHANNEL_CAP_LIMITS)) {
      const [proveedor, buzon] =
        canal === 'email' ? ['gmail_oauth', `techo-${canal}@e.outreach.test`] : ['unipile', `unipile-techo-${canal}`];
      // Justo en el techo entra; uno más, en el día o en la semana, no.
      const { id } = (
        await w(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, daily_cap, weekly_cap)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [WS_E, canal, proveedor, buzon, techo.daily, techo.weekly],
        )
      ).rows[0] as { id: string };
      await assert.rejects(w('UPDATE outreach_channel_account SET daily_cap = $1 WHERE id = $2', [techo.daily + 1, id]), fuera, canal);
      await assert.rejects(w('UPDATE outreach_channel_account SET weekly_cap = $1 WHERE id = $2', [techo.weekly + 1, id]), fuera, canal);
    }
    // El caso del hallazgo: la web sube el LinkedIn de la persona a los números de un Gmail.
    const { id: li } = (
      await e(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id)
         VALUES ($1, 'linkedin', 'unipile', 'unipile-E-web') RETURNING id`,
        [WS_E],
      )
    ).rows[0] as { id: string };
    await assert.rejects(e('UPDATE outreach_channel_account SET daily_cap = 2000, weekly_cap = 10000 WHERE id = $1', [li]), fuera);
    await assert.rejects(e('UPDATE outreach_channel_account SET daily_cap = 101 WHERE id = $1', [li]), fuera);
    await assert.rejects(e('UPDATE outreach_channel_account SET weekly_cap = 201 WHERE id = $1', [li]), fuera);
    await assert.rejects(
      e(
        `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, daily_cap)
         VALUES ($1, 'instagram_dm', 'unipile', 'unipile-E-ig', 101)`,
        [WS_E],
      ),
      fuera,
    );
    // Por debajo, el tope es de la persona.
    await e('UPDATE outreach_channel_account SET daily_cap = 40, weekly_cap = 150 WHERE id = $1', [li]);

    // Un Gmail personal no es un Google Workspace: 500 al día y 3500 a la semana (§5.1).
    assert.deepEqual(channelCapLimits('email', 'Otra@Gmail.com'), PERSONAL_EMAIL_CAP_LIMITS);
    assert.deepEqual(channelCapLimits('email', 'ventas@marca.co'), CHANNEL_CAP_LIMITS.email);
    for (const buzon of ['techo-personal@gmail.com', 'techo-personal@googlemail.com']) {
      const { id } = (
        await w(
          `INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, daily_cap, weekly_cap)
           VALUES ($1, 'email', 'gmail_oauth', $2, $3, $4) RETURNING id`,
          [WS_E, buzon, PERSONAL_EMAIL_CAP_LIMITS.daily, PERSONAL_EMAIL_CAP_LIMITS.weekly],
        )
      ).rows[0] as { id: string };
      await assert.rejects(w('UPDATE outreach_channel_account SET daily_cap = 501 WHERE id = $1', [id]), fuera, buzon);
      await assert.rejects(w('UPDATE outreach_channel_account SET weekly_cap = 3501 WHERE id = $1', [id]), fuera, buzon);
    }
  });

  test('processing es del despachador: la web no pone un toque en él, no lo saca y no lo borra', async () => {
    const despachador = (err: { code?: string; message?: string }) =>
      err.code === '42501' && /processing es del despachador/.test(err.message ?? '');
    assert.equal(WORKER_ONLY_TOUCH_STATUS, 'processing');
    // Quién cuenta como despachador: el worker sí; la web no (tampoco el mc_app_ci del CI, que puede asumir mc_worker).
    const esDespachador = async (q: typeof e) =>
      ((await q('SELECT outreach_is_dispatcher() AS si')).rows[0] as { si: boolean }).si;
    assert.equal(await esDespachador(e), false);
    assert.equal(await esDespachador(w), true);
    // Un toque de LinkedIn (sin correo, el CHECK de recipient_address no aplica) que nace en processing desde la web.
    await assert.rejects(
      e(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, claimed_at, attempt_count)
         VALUES ($1, $2, $3, 'linkedin', 'Hola', 'processing', now(), 1)`,
        [WS_E, COMPANY_E, E_LINKEDIN],
      ),
      despachador,
    );
    const { id } = (
      await e(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
         VALUES ($1, $2, $3, 'linkedin', 'Hola', 'scheduled', now()) RETURNING id`,
        [WS_E, COMPANY_E, E_LINKEDIN],
      )
    ).rows[0] as { id: string };
    await assert.rejects(
      e(`UPDATE outbound_touch SET status = 'processing', claimed_at = now(), attempt_count = 1 WHERE id = $1`, [id]),
      despachador,
    );
    // El worker lo reclama (LinkedIn no lleva enlace de baja)…
    await w(`UPDATE outbound_touch SET status = 'processing', claimed_at = now(), attempt_count = 1 WHERE id = $1`, [id]);
    // …y desde la web ya no se mueve: ni a sent sin haberlo enviado, ni fuera de la cola, ni se borra.
    for (const status of ['sent', 'canceled', 'scheduled', 'draft']) {
      await assert.rejects(e('UPDATE outbound_touch SET status = $1 WHERE id = $2', [status, id]), despachador, status);
    }
    await assert.rejects(
      e('DELETE FROM outbound_touch WHERE id = $1', [id]),
      (err: { code?: string; message?: string }) => err.code === '42501' && /no se borra/.test(err.message ?? ''),
    );
    // Lo cierra quien lo reclamó.
    await w(`UPDATE outbound_touch SET status = 'sent', sent_at = now(), provider_message_id = 'unipile-msg-e1' WHERE id = $1`, [id]);
    assert.equal((await toque(id)).status, 'sent');
  });

  test('no se enrola a quien tiene el correo en la lista global aunque su ficha no lo diga', async () => {
    await t.admin(`INSERT INTO contact_suppression (email, reason) VALUES ('rebotada@e.outreach.test', 'hard_bounce')`);
    const [ficha] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${E_REBOTADA}'`);
    assert.equal(ficha?.opted_out, false, 'la ficha existía antes del rebote y no lo refleja');
    const optOut = (err: { code?: string; message?: string }) => err.code === '23514' && /opt-out/.test(err.message ?? '');
    await assert.rejects(
      e('INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id) VALUES ($1, $2, $3)', [WS_E, SEQ_E, E_REBOTADA]),
      optOut,
    );
    // Terminado sí se puede anotar, y no se reanuda.
    const { id } = (
      await e(
        `INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status, finished_at)
         VALUES ($1, $2, $3, 'completed', now()) RETURNING id`,
        [WS_E, SEQ_E, E_REBOTADA],
      )
    ).rows[0] as { id: string };
    await assert.rejects(e(`UPDATE outbound_enrollment SET status = 'active' WHERE id = $1`, [id]), optOut);
  });

  test('el enlace de baja se escribe al reclamar: si el envío no se confirma, el del primer intento sigue dando de baja', async () => {
    const sinEnlace = (intento: number) => (err: { code?: string; message?: string }) =>
      err.code === '23514' && new RegExp(`intento ${intento}\\) sin su enlace de baja`).test(err.message ?? '');
    const reescribe = (err: { code?: string; message?: string }) =>
      err.code === '23514' && /no se reescribe/.test(err.message ?? '');
    const { id } = (
      await e(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
         VALUES ($1, $2, $3, 'email', 'Hola', 'scheduled', now()) RETURNING id`,
        [WS_E, COMPANY_E, E_CORREO],
      )
    ).rows[0] as { id: string };
    const reclamo = `UPDATE outbound_touch SET status = 'processing', claimed_at = now(), attempt_count = attempt_count + 1,
                            recipient_address = 'correo@e.outreach.test' WHERE id = $1`;
    const enlace = (token: string, intento: number) =>
      `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address)
       VALUES ('${sha256(token)}', '${WS_E}', '${id}', '${E_CORREO}', ${intento}, 'correo@e.outreach.test')`;

    // Reclamar un correo sin escribir su enlace no se confirma: el COMMIT falla y el toque sigue en la cola.
    await assert.rejects(w(reclamo, [id]), sinEnlace(1));
    assert.equal((await toque(id)).status, 'scheduled');
    // Si en la misma transacción lo cancela antes de llamar al proveedor (4.1), no hace falta enlace: no sale nada.
    await t.db.asWorker(async (tx) => {
      await tx.query(reclamo, [id]);
      await tx.query(`UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'outreach_disabled' WHERE id = $1`, [id]);
    });
    await w(`UPDATE outbound_touch SET status = 'scheduled', attempt_count = 0 WHERE id = $1`, [id]);

    // Intento 1: reclama y escribe el enlace, y llama a Gmail. La respuesta se pierde (timeout): nadie anota sent_at.
    await t.db.asWorker(async (tx) => {
      await tx.query(reclamo, [id]);
      await tx.query(enlace(TOKEN_E1, 1));
    });
    // El rescate del zombi lo devuelve a la cola, para otro intento.
    await w(`UPDATE outbound_touch SET status = 'scheduled', next_retry_at = now() WHERE id = $1`, [id]);

    // Intento 2: el enlace del 1 no vale para el 2, ni se repite su número.
    await assert.rejects(w(reclamo, [id]), sinEnlace(2));
    await assert.rejects(
      t.db.asWorker(async (tx) => {
        await tx.query(reclamo, [id]);
        await tx.query(enlace(TOKEN_E2, 1));
      }),
      /outbound_optout_link_touch_idx/,
    );
    await t.db.asWorker(async (tx) => {
      await tx.query(reclamo, [id]);
      await tx.query(enlace(TOKEN_E2, 2));
    });
    // Esta vez el proveedor confirma: el toque sale y su enlace anota sent_at, una vez.
    await t.db.asWorker(async (tx) => {
      await tx.query(`UPDATE outbound_touch SET status = 'sent', sent_at = now(), provider_message_id = 'gmail-e-2' WHERE id = $1`, [id]);
      await tx.query(`UPDATE outbound_optout_link SET sent_at = now() WHERE token_hash = $1`, [sha256(TOKEN_E2)]);
    });
    await assert.rejects(w('UPDATE outbound_optout_link SET sent_at = now() WHERE token_hash = $1', [sha256(TOKEN_E2)]), reescribe);
    await assert.rejects(
      w(`UPDATE outbound_optout_link SET recipient_address = 'otra@e.outreach.test' WHERE token_hash = $1`, [sha256(TOKEN_E1)]),
      reescribe,
    );
    const enlaces = await sinRls<{ attempt: number; enviado: boolean }>(
      `SELECT attempt, sent_at IS NOT NULL AS enviado FROM outbound_optout_link WHERE touch_id = '${id}' ORDER BY attempt`,
    );
    assert.deepEqual(enlaces.map((x) => ({ ...x })), [{ attempt: 1, enviado: false }, { attempt: 2, enviado: true }]);

    // La persona pulsa el enlace del PRIMER correo, el que quizá salió sin que nadie lo confirmara: se da de baja.
    const { r } = await baja(TOKEN_E1);
    assert.equal(r.status, 'ok');
    assert.equal(r.status === 'ok' && r.touchId, id);
    const [ficha] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${E_CORREO}'`);
    assert.equal(ficha?.opted_out, true);
    const [clic] = await sinRls<{ reclamado: boolean; enviado: boolean }>(
      `SELECT claimed_at IS NOT NULL AS reclamado, sent_at IS NOT NULL AS enviado
         FROM outbound_optout_event WHERE token_hash = '${sha256(TOKEN_E1)}'`,
    );
    assert.deepEqual({ ...clic }, { reclamado: true, enviado: false });
  });

  test('outbound_health lee la ventana, no la historia: lo viejo no cuenta y lastSentAt es el último enviado', async () => {
    await t.admin(`
      INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, sent_at, opened_at,
                                  replied_at, status_changed_at, created_at) VALUES
        ('${WS_E}', '${COMPANY_E}', '${E_LINKEDIN}', 'linkedin', 'Viejo', 'sent', now() - interval '60 days',
         now() - interval '59 days', now() - interval '58 days', now() - interval '60 days', now() - interval '61 days'),
        ('${WS_E}', '${COMPANY_E}', '${E_LINKEDIN}', 'linkedin', 'Fallo viejo', 'failed', NULL, NULL, NULL,
         now() - interval '40 days', now() - interval '41 days');
    `);
    const h = await t.db.withWorkspace(WS_E, (tx) => outboundHealth(tx, 24));
    // Lo de hoy: el LinkedIn y el correo del intento 2, que salieron en las pruebas de arriba.
    assert.equal(h.window.sent, 2);
    assert.equal(h.window.failed, 0);
    assert.equal(h.window.opened, 0);
    assert.equal(h.window.replied, 0);
    assert.deepEqual(h.byChannel, { email: { sent: 1, failed: 0 }, linkedin: { sent: 1, failed: 0 } });
    assert.deepEqual(h.queue, { draft: 0, scheduled: 0, due: 0, processing: 0, stuck: 0, held: 0 });
    const [ultimo] = await sinRls<{ ultimo: string }>(
      `SELECT max(sent_at)::text AS ultimo FROM outbound_touch WHERE workspace_id = '${WS_E}' AND status = 'sent'`,
    );
    assert.equal(new Date(h.lastSentAt!).getTime(), new Date(ultimo!.ultimo).getTime());
    // Con la ventana más larga (720 h, 30 días), el envío de hace 60 días y el fallo de hace 40 siguen fuera.
    const mes = await t.db.withWorkspace(WS_E, (tx) => outboundHealth(tx, 720));
    assert.equal(mes.window.sent, 2);
    assert.equal(mes.window.failed, 0);

    // Una baja de hoy en OTRO workspace, a quien ese workspace sí le escribió, no cuenta en la de E.
    const OTRO_WS = '00000037-0000-4000-8000-0000000000f0';
    const OTRA_EMPRESA = '00000037-0000-4000-8000-0000000000f1';
    const OTRA = '00000037-0000-4000-8000-0000000000f2';
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${OTRO_WS}', 'outreach-f', 'Outreach F', 'UTC');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${OTRA_EMPRESA}', 'Empresa de F', '${OTRO_WS}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${OTRO_WS}', '${OTRA_EMPRESA}');
      INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id)
      VALUES ('${OTRA}', '${OTRA_EMPRESA}', 'Baja de F', 'baja-hoy@f.outreach.test', 'user_provided', '${OTRO_WS}');
      INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, sent_at, recipient_address,
                                  provider_message_id, attempt_count)
      VALUES ('${OTRO_WS}', '${OTRA_EMPRESA}', '${OTRA}', 'email', 'Hola', 'sent', now() - interval '1 hour',
              'baja-hoy@f.outreach.test', 'gmail-f-baja-hoy', 1);
      UPDATE contact SET opted_out = true, opted_out_at = now() WHERE id = '${OTRA}';
    `);
    try {
      const despues = await t.db.withWorkspace(WS_E, (tx) => outboundHealth(tx, 24));
      assert.equal(despues.window.optedOut, h.window.optedOut);
      const deF = await t.db.asWorker((tx) => outboundHealth(tx, 24, OTRO_WS));
      assert.equal(deF.window.optedOut, 1, 'en F sí cuenta');
    } finally {
      if (t.kind === 'postgres') {
        await t.admin(`DELETE FROM workspace WHERE id = '${OTRO_WS}'; DELETE FROM company WHERE id = '${OTRA_EMPRESA}';`);
      }
    }
  });
});
