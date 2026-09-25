/**
 * VEN-10 · los mensajes de la cadencia en la ficha y la aprobación de
 * un retenido (releaseHeldTouch), con la RLS del workspace como la web:
 *
 *   · la ficha lista los mensajes de cadencia de SU empresa, retenidos
 *     primero, con la respuesta que llegó; otro workspace no ve nada;
 *   · aprobar revalida lo que mira el despachador (texto, huecos, nota
 *     de LinkedIn, asunto, dirección postal, baja) y devuelve el mensaje
 *     a la cola con el texto que dejó la persona;
 *   · aprobar un retenido por un intento sin comprobar borra esa marca
 *     (0052 §2 se lo deja a mc_app solo desde 'held'); fuera de esa
 *     transición la columna sigue siendo del despachador;
 *   · otro workspace no puede aprobar lo ajeno;
 *   · (0053) «sí salió» con la RLS de la web: outreach_resolve_unconfirmed
 *     deja el toque enviado y anota el enlace de ese intento, que la web
 *     sola no puede escribir.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { listCompanyCadenceTouches, releaseHeldTouch, resolveUnconfirmedTouch } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const id = (kind: string) => `00000052-0000-4000-8000-${kind.padStart(12, '0')}`;
const WS_A = id('a');
const WS_B = id('b');
const CO = id('c1');
const CONTACT = id('d1');
const SEQ = id('5e');
const ENR = id('e1');
const T = { review: id('71'), huecos: id('72'), ambiguo: id('73'), enviado: id('74'), nota: id('75') };
const STEP_LI = id('5e02');

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_A}', 'aprobar-a', 'Aprobar A', 'America/Bogota'),
                                                          ('${WS_B}', 'aprobar-b', 'Aprobar B', 'America/Bogota');
    INSERT INTO outbound_policy (workspace_id, postal_address) VALUES ('${WS_A}', 'Calle 93 # 11-26, Bogotá');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Vitalé', '${WS_A}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${CO}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, linkedin_url, source)
    VALUES ('${CONTACT}', '${CO}', '${WS_A}', 'Sofía Cárdenas', 'sofia@vitale.test', 'https://www.linkedin.com/in/sofia', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ}', '${WS_A}', 'Tres toques', 'email', 'active');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, body_template)
    VALUES ('${STEP_LI}', '${WS_A}', '${SEQ}', 3, 0, 'linkedin_connect', 'linkedin', '10:00', 'Hola');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status) VALUES ('${ENR}', '${WS_A}', '${SEQ}', '${CONTACT}', 'active');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
                                subject, body, status, scheduled_for, held_reason) VALUES
      ('${T.review}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 1, '${ENR}', NULL, 'email', 'Hola, Sofía', 'Una idea para Vitalé.',
       'held', now() + interval '1 day', 'needs_review'),
      ('${T.huecos}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 2, '${ENR}', NULL, 'email', 'Sigo', 'Hola, {{first_name}}.',
       'held', now() + interval '2 days', 'placeholders:{{first_name}}'),
      ('${T.ambiguo}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 3, '${ENR}', NULL, 'email', 'Cierro', 'Cierro por aquí.',
       'held', now() + interval '3 days', 'unconfirmed_attempt:1'),
      ('${T.nota}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 4, '${ENR}', '${STEP_LI}', 'linkedin', NULL, 'Hola',
       'held', now() + interval '4 days', 'needs_review'),
      ('${T.enviado}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 0, '${ENR}', NULL, 'email', 'Antes', 'Lo de antes.',
       'draft', now() - interval '2 days', NULL);
  `);
  // Lo que deja el despachador: el intento sin comprobar, y la respuesta al primer mensaje.
  await t.db.asWorker(async (tx) => {
    await tx.query(`UPDATE outbound_touch SET unconfirmed_attempt = 1, unconfirmed_caps_on = current_date WHERE id = $1`, [T.ambiguo]);
    await tx.query(
      `INSERT INTO outbound_message (workspace_id, touch_id, contact_id, enrollment_id, direction, channel, thread_ref, provider_message_id, body, occurred_at)
       VALUES ($1, $2, $3, $4, 'inbound', 'email', 'hilo-1', 'resp-1', '¡Hola! Nos interesa, hablemos.', now())`,
      [WS_A, T.enviado, CONTACT, ENR],
    );
  });
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

test('la ficha lista los mensajes de su empresa, los retenidos primero y con la respuesta; otro workspace no ve nada', async () => {
  const lista = await t.db.withWorkspace(WS_A, (tx) => listCompanyCadenceTouches(tx, CO));
  assert.deepEqual(lista.slice(0, 4).map((x) => x.status), ['held', 'held', 'held', 'held']);
  assert.equal(lista[0]!.id, T.review, 'por su hora: el que sale antes');
  const conRespuesta = lista.find((x) => x.id === T.enviado)!;
  assert.equal(conRespuesta.reply?.body, '¡Hola! Nos interesa, hablemos.');
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => listCompanyCadenceTouches(tx, CO)), []);
});

test('aprobar revalida lo que mira el despachador y devuelve el mensaje a la cola con lo que dejó la persona', async () => {
  const aprobar = (touch: string, subject: string | null, body: string, ws = WS_A) =>
    t.db.withWorkspace(ws, (tx) => releaseHeldTouch(tx, touch, { subject, body }));
  assert.deepEqual(await aprobar(T.review, 'Hola', 'Una idea.', WS_B), { ok: false, code: 'not_found' }, 'lo ajeno no se ve');
  assert.deepEqual(await aprobar(T.huecos, 'Sigo', 'Hola, {{first_name}}.'), { ok: false, code: 'placeholders', detail: '{{first_name}}' });
  assert.deepEqual(await aprobar(T.review, '', 'Una idea.'), { ok: false, code: 'empty_subject' });
  assert.deepEqual(await aprobar(T.review, 'Hola', '   '), { ok: false, code: 'empty' });
  assert.deepEqual(await aprobar(T.nota, null, 'á'.repeat(301)), { ok: false, code: 'note_too_long', detail: '301' });

  assert.deepEqual(await aprobar(T.huecos, 'Sigo', 'Hola, Sofía.'), { ok: true });
  const fila = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; held_reason: string | null; body: string }>(
      `SELECT status, held_reason, body FROM outbound_touch WHERE id = $1`, [T.huecos],
    )).rows[0]!,
  );
  assert.deepEqual({ ...fila }, { status: 'scheduled', held_reason: null, body: 'Hola, Sofía.' });
  assert.deepEqual(await aprobar(T.huecos, 'Sigo', 'Hola, Sofía.'), { ok: false, code: 'not_held' }, 'dos veces no');
});

test('aprobar un retenido por un intento sin comprobar borra esa marca; fuera de esa transición, sigue siendo del despachador', async () => {
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => releaseHeldTouch(tx, T.ambiguo, { subject: 'Cierro', body: 'Cierro por aquí.' })), { ok: true });
  const fila = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; ua: number | null; uc: string | null }>(
      `SELECT status, unconfirmed_attempt AS ua, unconfirmed_caps_on::text AS uc FROM outbound_touch WHERE id = $1`, [T.ambiguo],
    )).rows[0]!,
  );
  assert.deepEqual({ ...fila }, { status: 'scheduled', ua: null, uc: null });
  await assert.rejects(
    t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_touch SET unconfirmed_attempt = 2 WHERE id = $1`, [T.ambiguo])),
    /solo el despachador/,
  );
});

test('«sí salió» con la RLS de la web: el toque queda enviado y el enlace de ese intento cuenta; otro workspace no lo ve (0053)', async () => {
  const toque = id('76');
  await t.admin(`
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, channel, subject, body,
                                status, scheduled_for, held_reason)
    VALUES ('${toque}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 5, '${ENR}', 'email', 'Otra', 'Otra idea.', 'held', now(),
            'unconfirmed_attempt:1');
  `);
  await t.db.asWorker(async (tx) => {
    await tx.query(
      `UPDATE outbound_touch SET unconfirmed_attempt = 1, recipient_address = 'sofia@vitale.test', attempt_count = 1 WHERE id = $1`,
      [toque],
    );
    await tx.query(
      `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at)
       VALUES (repeat('a', 64), $1, $2, $3, 1, 'sofia@vitale.test', now())`,
      [WS_A, toque, CONTACT],
    );
  });
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => resolveUnconfirmedTouch(tx, toque, 'was_sent')), { ok: false, code: 'not_found' });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => resolveUnconfirmedTouch(tx, T.review, 'was_sent')), { ok: false, code: 'not_unconfirmed' });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => resolveUnconfirmedTouch(tx, toque, 'was_sent')), { ok: true });
  const fila = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; motivo: string | null; ua: number | null; enlace: boolean }>(
      `SELECT t.status, t.blocked_reason AS motivo, t.unconfirmed_attempt AS ua,
              (SELECT l.sent_at IS NOT NULL FROM outbound_optout_link l WHERE l.touch_id = t.id AND l.attempt = 1) AS enlace
         FROM outbound_touch t WHERE t.id = $1`,
      [toque],
    )).rows[0]!,
  );
  assert.deepEqual({ ...fila }, { status: 'sent', motivo: 'sent_confirmed_by_user', ua: null, enlace: true });
  // La web sigue sin poder escribir el enlace ni las columnas del intento por su cuenta.
  await assert.rejects(
    t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_optout_link SET sent_at = now() WHERE touch_id = $1`, [toque])),
    /permission denied/,
  );
});

test('sin dirección postal un correo no se aprueba; y una ficha dada de baja, tampoco', async () => {
  await t.admin(`UPDATE outbound_policy SET postal_address = NULL WHERE workspace_id = '${WS_A}'`);
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => releaseHeldTouch(tx, T.review, { subject: 'Hola', body: 'Una idea.' })),
    { ok: false, code: 'no_postal_address' },
  );
  await t.admin(`UPDATE outbound_policy SET postal_address = 'Calle 93 # 11-26, Bogotá' WHERE workspace_id = '${WS_A}';
                 UPDATE contact SET opted_out = true WHERE id = '${CONTACT}'`);
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => releaseHeldTouch(tx, T.review, { subject: 'Hola', body: 'Una idea.' })),
    { ok: false, code: 'opted_out' },
  );
});
