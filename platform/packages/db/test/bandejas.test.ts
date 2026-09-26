/**
 * VEN-14 · las bandejas con la RLS de la web (mc_app y withWorkspace):
 *
 *   · la cola de aprobación, los hilos y la conversación son del espacio
 *     que mira; otro espacio no ve nada, no aprueba, no salta, no marca
 *     leído y no responde;
 *   · la respuesta de la bandeja solo apunta a un mensaje entrante de la
 *     misma ficha, canal y espacio (outbound_touch_reply_check, 0064):
 *     escribir el toque a mano con un mensaje ajeno o saliente se rechaza;
 *   · aprobar, responder y crear el referido funcionan como mc_app.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveQueuedTouch, cancelInboxReply, createReferralContact, dismissInboxReply, listApprovalQueue, listInboxThreads,
  loadInboxConversation, markInboxThreadDone, markInboxThreadRead, outreachClassifierStatus, reclassifyInboxMessage,
  replyInInboxThread, skipQueuedTouch, undoApproval,
} from '../src/queries/bandejas.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const id = (kind: string) => `00000140-0000-4000-8000-${kind.padStart(12, '0')}`;
const WS_A = id('a');
const WS_B = id('b');
const CO = id('c1');
const CONTACT = id('d1');
const CONTACT_B = id('d2');
const CO_B = id('c2');
const HELD = id('71');
const HELD2 = id('72');
const SENT = id('73');
const INBOUND = id('a5');
const OUTBOUND_MSG = id('a6');
const INBOUND_B = id('a7');
const CONTACT_2 = id('d3');
const AMBIGUA = id('a8');
const INTERESADA = id('a9');
const DEAL = id('de1');

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_A}', 'bandejas-a', 'Bandejas A', 'America/Bogota'),
                                                          ('${WS_B}', 'bandejas-b', 'Bandejas B', 'America/Bogota');
    INSERT INTO outbound_policy (workspace_id, postal_address) VALUES ('${WS_A}', 'Calle 93 # 11-26, Bogotá');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Vitalé', '${WS_A}'), ('${CO_B}', 'Otra', '${WS_B}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${CO}'), ('${WS_B}', '${CO_B}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${CONTACT}', '${CO}', '${WS_A}', 'Sofía Cárdenas', 'sofia@vitale.test', 'user_provided'),
           ('${CONTACT_B}', '${CO_B}', '${WS_B}', 'Pedro Otro', 'pedro@otra.test', 'user_provided'),
           ('${CONTACT_2}', '${CO}', '${WS_A}', 'Julián Vitalé', 'julian@vitale.test', 'user_provided');
    INSERT INTO deal (id, workspace_id, company_id, name, stage_id) VALUES ('${DEAL}', '${WS_A}', '${CO}', 'Temporada', 'contactado');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for, held_reason) VALUES
      ('${HELD}', '${WS_A}', '${CO}', '${CONTACT}', 'email', 'Hola, Sofía', 'Una idea para Vitalé.', 'held', now() + interval '1 day', 'needs_review'),
      ('${HELD2}', '${WS_A}', '${CO}', '${CONTACT}', 'email', 'Otra', 'Otra idea para Vitalé.', 'held', now() + interval '2 days', 'quality_warmup:3'),
      ('${SENT}', '${WS_A}', '${CO}', '${CONTACT}', 'email', 'Antes', 'Lo de antes.', 'draft', now() - interval '2 days', NULL);
  `);
  await t.db.asWorker(async (tx) => {
    await tx.query(
      `INSERT INTO outbound_message (id, workspace_id, touch_id, contact_id, direction, channel, thread_ref, provider_message_id, subject, body,
                                     occurred_at, intent, intent_confidence, intent_source, classified_at, referral)
       VALUES ($1, $2, $3, $4, 'outbound', 'email', 'hilo-1', 'env-1', 'Antes', 'Lo de antes.', now() - interval '2 days', NULL, NULL, NULL, NULL, NULL),
              ($5, $2, $3, $4, 'inbound', 'email', 'hilo-1', 'resp-1', 'Re: Antes', 'Habla con Ana: ana@vitale.test', now() - interval '1 day',
               'referral', 0.9, 'model', now(), '{"name":"Ana","email":"ana@vitale.test","role":null}'::jsonb),
              ($6, $7, NULL, $8, 'inbound', 'email', 'hilo-b', 'resp-b', NULL, 'Hola desde B', now(), NULL, NULL, NULL, NULL, NULL),
              ($9, $2, NULL, $10, 'inbound', 'linkedin', 'chat-2', 'resp-2', NULL, 'Ok, lo miro.', now() - interval '3 hours',
               'ambiguous', 0.4, 'model', now(), NULL),
              ($11, $2, NULL, $10, 'inbound', 'linkedin', 'chat-2', 'resp-3', NULL, 'Me interesa, mándame tarifas.', now() - interval '2 hours',
               'interested', 0.95, 'model', now(), NULL)`,
      [OUTBOUND_MSG, WS_A, SENT, CONTACT, INBOUND, INBOUND_B, WS_B, CONTACT_B, AMBIGUA, CONTACT_2, INTERESADA],
    );
  });
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

test('la cola, los hilos y la conversación son del espacio que mira', async () => {
  const cola = await t.db.withWorkspace(WS_A, (tx) => listApprovalQueue(tx));
  assert.deepEqual(cola.items.map((x) => [x.touchId, x.heldReason]), [[HELD, 'needs_review'], [HELD2, 'quality_warmup:3']]);
  assert.equal(cola.total, 2);
  const primero = await t.db.withWorkspace(WS_A, (tx) => listApprovalQueue(tx, { limit: 1 }));
  assert.deepEqual([primero.items.length, primero.total], [1, 2], 'el total cuenta toda la cola aunque se enseñe menos');
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => listApprovalQueue(tx)), { items: [], total: 0 });

  const hilos = await t.db.withWorkspace(WS_A, (tx) => listInboxThreads(tx));
  assert.deepEqual(hilos.map((h) => [h.contactId, h.channel, h.unread, h.lastIntent]), [
    [CONTACT_2, 'linkedin', 2, 'interested'],
    [CONTACT, 'email', 1, 'referral'],
  ]);
  assert.deepEqual((await t.db.withWorkspace(WS_B, (tx) => listInboxThreads(tx))).map((h) => h.contactId), [CONTACT_B]);
  assert.equal(await t.db.withWorkspace(WS_B, (tx) => loadInboxConversation(tx, CONTACT, 'email')), null, 'la conversación ajena no existe');
  const conv = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT, 'email')))!;
  assert.deepEqual(conv.messages.map((m) => m.direction), ['outbound', 'inbound']);
  assert.equal(conv.replyToMessageId, INBOUND);
});

test('otro espacio no aprueba, no salta, no marca leído, no responde ni crea el referido', async () => {
  const now = new Date();
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => approveQueuedTouch(tx, { touchId: HELD, userId: null, now })), { ok: false, code: 'not_found' });
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => skipQueuedTouch(tx, HELD, now)), { ok: false, code: 'not_found' });
  assert.equal(await t.db.withWorkspace(WS_B, (tx) => markInboxThreadRead(tx, CONTACT, 'email', now)), 0);
  assert.deepEqual(
    await t.db.withWorkspace(WS_B, (tx) =>
      replyInInboxThread(tx, { touchId: id('99'), contactId: CONTACT, channel: 'email', body: 'Hola', userId: null, now }),
    ),
    { ok: false, code: 'not_found' },
  );
  assert.deepEqual(
    await t.db.withWorkspace(WS_B, (tx) => createReferralContact(tx, { messageId: INBOUND, fullName: 'Ana', email: null, roleTitle: null })),
    { ok: false, code: 'not_found' },
  );
});

test('la respuesta de la bandeja solo apunta a un mensaje entrante de la misma ficha, canal y espacio', async () => {
  const insertar = (ws: string, message: string, contact: string, company: string) =>
    t.db.withWorkspace(ws, (tx) =>
      tx.query(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for, reply_to_message_id)
         VALUES ($1, $2, $3, 'email', 'Hola', 'scheduled', now(), $4)`,
        [ws, company, contact, message],
      ),
    );
  await assert.rejects(insertar(WS_B, INBOUND, CONTACT_B, CO_B), /mensaje entrante/, 'un mensaje de otro espacio');
  await assert.rejects(insertar(WS_A, OUTBOUND_MSG, CONTACT, CO), /mensaje entrante/, 'un mensaje nuestro');
});

test('como mc_app: aprobar, marcar leído, responder una vez y crear el referido', async () => {
  const now = new Date();
  // La política de A no está encendida: aprobado, pero no sale hasta que se encienda (y la pantalla lo dice).
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => approveQueuedTouch(tx, { touchId: HELD, userId: null, now })), {
    ok: true, approvedAt: now, sendingOff: true, recipientName: 'Sofía Cárdenas',
  });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => skipQueuedTouch(tx, HELD2, now)), { ok: true, recipientName: 'Sofía Cárdenas' });
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => markInboxThreadRead(tx, CONTACT, 'email', now)), 1);
  const touchId = id('98');
  const responder = () =>
    t.db.withWorkspace(WS_A, (tx) =>
      replyInInboxThread(tx, { touchId, contactId: CONTACT, channel: 'email', body: 'Gracias, le escribo a Ana.', userId: null, now }),
    );
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: false, sendingOff: true });
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: true, sendingOff: true });
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) =>
      replyInInboxThread(tx, { touchId: id('97'), contactId: CONTACT, channel: 'email', body: 'Hola, {{first_name}}', userId: null, now }),
    ),
    { ok: false, code: 'placeholders', detail: '{{first_name}}' },
  );
  const conv = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT, 'email')))!;
  assert.deepEqual(conv.pending.map((p) => [p.touchId, p.status]), [[touchId, 'scheduled']]);
  const creado = await t.db.withWorkspace(WS_A, (tx) =>
    createReferralContact(tx, { messageId: INBOUND, fullName: 'Ana Ruiz', email: 'ana@vitale.test', roleTitle: 'Mercadeo' }),
  );
  assert.equal(creado.ok, true);
  const again = await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT, 'email'));
  assert.equal(again!.messages[1]!.referralContactId, creado.ok ? creado.contactId : null);
});

test('deshacer una aprobación la devuelve a la cola con el motivo que guardó el servidor, solo si sigue programada con esa aprobación', async () => {
  const now = new Date('2026-09-24T15:00:00Z');
  await t.db.withWorkspace(WS_A, (tx) =>
    tx.query(`UPDATE outbound_touch SET status = 'held', held_reason = 'quality_risk:unsourced_figure', approved_at = NULL WHERE id = $1`, [HELD]),
  );
  const r = await t.db.withWorkspace(WS_A, (tx) => approveQueuedTouch(tx, { touchId: HELD, userId: null, now }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // El motivo no viaja al navegador: lo guarda el toque (0066).
  assert.ok(!('heldReason' in r));
  const guardado = await t.db.withWorkspace(WS_A, (tx) =>
    tx.query<{ held_reason: string | null; approved_from_reason: string | null }>(
      'SELECT held_reason, approved_from_reason FROM outbound_touch WHERE id = $1', [HELD],
    ),
  );
  assert.deepEqual(guardado.rows[0], { held_reason: null, approved_from_reason: 'quality_risk:unsourced_figure' });
  assert.deepEqual(
    await t.db.withWorkspace(WS_B, (tx) => undoApproval(tx, { touchId: HELD, approvedAt: r.approvedAt })),
    { ok: false, code: 'not_found' }, 'otro espacio no deshace',
  );
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => undoApproval(tx, { touchId: HELD, approvedAt: new Date(now.getTime() + 1000) })),
    { ok: false, code: 'not_undoable' }, 'otra aprobación no se deshace',
  );
  // Una petición con un motivo inventado no lo cuela: la función ya no lo acepta, y uno de más se ignora.
  const alterada = { touchId: HELD, approvedAt: r.approvedAt, heldReason: 'unconfirmed_attempt:1' } as Parameters<typeof undoApproval>[1];
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => undoApproval(tx, alterada)), { ok: true, recipientName: 'Sofía Cárdenas' });
  const cola = await t.db.withWorkspace(WS_A, (tx) => listApprovalQueue(tx));
  assert.deepEqual(cola.items.map((x) => [x.touchId, x.heldReason]), [[HELD, 'quality_risk:unsourced_figure']]);
  const limpio = await t.db.withWorkspace(WS_A, (tx) =>
    tx.query<{ approved_from_reason: string | null }>('SELECT approved_from_reason FROM outbound_touch WHERE id = $1', [HELD]),
  );
  assert.equal(limpio.rows[0]!.approved_from_reason, null, 'al deshacer se vacía');
});

test('saltar solo lo que la cola ofrece: un borrador de cadencia sin petición de regenerar no se salta', async () => {
  const now = new Date();
  const SEQ = id('5e1');
  const ENR = id('e1');
  const BORRADOR = id('74');
  const PEDIDO = id('75');
  await t.admin(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel) VALUES ('${SEQ}', '${WS_A}', 'Saltos', 'email');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status) VALUES ('${ENR}', '${WS_A}', '${SEQ}', '${CONTACT}', 'active');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, enrollment_id, channel, subject, body, status) VALUES
      ('${BORRADOR}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', '${ENR}', 'email', 'Borrador', 'La IA lo redacta.', 'draft'),
      ('${PEDIDO}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', '${ENR}', 'email', 'Pedido', 'Otra versión, por favor.', 'draft');
    INSERT INTO outbound_generation (touch_id, workspace_id, requested_at) VALUES ('${PEDIDO}', '${WS_A}', now());
  `);
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => skipQueuedTouch(tx, BORRADOR, now)), { ok: false, code: 'not_skippable' });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => skipQueuedTouch(tx, PEDIDO, now)), { ok: true, recipientName: 'Sofía Cárdenas' });
  const estados = await t.db.withWorkspace(WS_A, (tx) =>
    tx.query<{ id: string; status: string }>('SELECT id, status FROM outbound_touch WHERE id IN ($1, $2) ORDER BY id', [BORRADOR, PEDIDO]),
  );
  assert.deepEqual(estados.rows.map((x) => [x.id, x.status]), [[BORRADOR, 'draft'], [PEDIDO, 'skipped']]);
});

test('responder con un id que ya es de otro espacio no finge que salió; cancelar y descartar solo lo propio', async () => {
  const now = new Date();
  // Un toque de B con un id que A no ve.
  const ajeno = id('96');
  await t.admin(`INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
                 VALUES ('${ajeno}', '${WS_B}', '${CO_B}', '${CONTACT_B}', 'email', 'De B', 'scheduled', now())`);
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) =>
      replyInInboxThread(tx, { touchId: ajeno, contactId: CONTACT, channel: 'email', body: 'Hola', userId: null, now }),
    ),
    { ok: false, code: 'not_found' },
  );
  const touchId = id('95');
  const r = await t.db.withWorkspace(WS_A, (tx) =>
    replyInInboxThread(tx, { touchId, contactId: CONTACT, channel: 'email', body: 'Con errata', userId: null, now }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => cancelInboxReply(tx, touchId)), { ok: false, code: 'not_found' });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => cancelInboxReply(tx, touchId)), { ok: true, body: 'Con errata' });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => cancelInboxReply(tx, touchId)), { ok: false, code: 'not_cancelable' });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => cancelInboxReply(tx, HELD2)), { ok: false, code: 'not_found' }, 'un toque de cadencia no se cancela aquí');
  const conv = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT, 'email')))!;
  const noSalio = conv.notSent.find((p) => p.touchId === touchId)!;
  assert.deepEqual([noSalio.status, noSalio.blockedReason, noSalio.cancelable], ['canceled', 'canceled_by_person', false]);
  assert.ok(!conv.pending.some((p) => p.touchId === touchId), 'no sale bajo «por salir»');
  assert.equal(await t.db.withWorkspace(WS_B, (tx) => dismissInboxReply(tx, touchId, now)), false);
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => dismissInboxReply(tx, touchId, now)), true);
  const despues = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT, 'email')))!;
  assert.ok(!despues.notSent.some((p) => p.touchId === touchId), 'descartada, ya no se ve');
});

test('el referido solo se crea desde un mensaje que es un referido', async () => {
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => createReferralContact(tx, { messageId: INTERESADA, fullName: 'Otra', email: null, roleTitle: null })),
    { ok: false, code: 'not_found' },
  );
});

test('marcar como hecho saca el hilo de los pendientes; reabrir lo devuelve', async () => {
  const now = new Date();
  assert.equal(await t.db.withWorkspace(WS_B, (tx) => markInboxThreadDone(tx, { contactId: CONTACT_2, channel: 'linkedin', done: true, now })), 0);
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => markInboxThreadDone(tx, { contactId: CONTACT_2, channel: 'linkedin', done: true, now })), 2);
  const pendientes = await t.db.withWorkspace(WS_A, (tx) => listInboxThreads(tx, { filter: 'pending' }));
  assert.ok(!pendientes.some((h) => h.contactId === CONTACT_2));
  const hechos = await t.db.withWorkspace(WS_A, (tx) => listInboxThreads(tx, { filter: 'done' }));
  assert.deepEqual(hechos.map((h) => [h.contactId, h.done, h.unread]), [[CONTACT_2, true, 0]], 'hecho también es leído');
  assert.equal((await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT_2, 'linkedin')))!.done, true);
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => markInboxThreadDone(tx, { contactId: CONTACT_2, channel: 'linkedin', done: false, now })), 2);
  assert.ok((await t.db.withWorkspace(WS_A, (tx) => listInboxThreads(tx, { filter: 'pending' }))).some((h) => h.contactId === CONTACT_2));
});

test('como mc_app: una persona corrige la intención y se aplican sus efectos; una baja no se corrige', async () => {
  const now = new Date('2026-09-24T15:00:00Z');
  assert.deepEqual(
    await t.db.withWorkspace(WS_B, (tx) => reclassifyInboxMessage(tx, { messageId: AMBIGUA, intent: 'interested', now })),
    { ok: false, code: 'not_found' }, 'lo ajeno no existe',
  );
  const r = await t.db.withWorkspace(WS_A, (tx) => reclassifyInboxMessage(tx, { messageId: AMBIGUA, intent: 'interested', now }));
  assert.deepEqual(r, { ok: true, intent: 'interested', dealMoved: true, optOut: false, optOutReview: false });
  const conv = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT_2, 'linkedin')))!;
  const m = conv.messages.find((x) => x.id === AMBIGUA)!;
  assert.deepEqual([m.intent, m.intentSource, m.intentConfidence], ['interested', 'person', 1]);
  assert.equal(conv.deal?.stageId, 'conversacion', 'el negocio pasa a «En conversación»');
  assert.equal(conv.deal?.nextAction, 'Responder hoy');

  // Una baja: la ficha queda de baja, y ya no se corrige.
  const baja = await t.db.withWorkspace(WS_A, (tx) => reclassifyInboxMessage(tx, { messageId: INTERESADA, intent: 'unsubscribe', now }));
  assert.equal(baja.ok && baja.optOut, true);
  const ficha = await t.db.withWorkspace(WS_A, (tx) => tx.query<{ opted_out: boolean }>('SELECT opted_out FROM contact WHERE id = $1', [CONTACT_2]));
  assert.equal(ficha.rows[0]!.opted_out, true);
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => reclassifyInboxMessage(tx, { messageId: INTERESADA, intent: 'interested', now })),
    { ok: false, code: 'opted_out' },
  );
});

test('corregir a «fuera de la oficina» lee la fecha de vuelta del mensaje, o usa la que escribe la persona', async () => {
  const now = new Date('2026-09-24T15:00:00Z');
  const CONTACT_3 = id('d4');
  const OOO = id('aa');
  const OOO2 = id('ab');
  await t.admin(`INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
                 VALUES ('${CONTACT_3}', '${CO}', '${WS_A}', 'Marta Vitalé', 'marta@vitale.test', 'user_provided')`);
  await t.db.asWorker((tx) =>
    tx.query(
      `INSERT INTO outbound_message (id, workspace_id, contact_id, direction, channel, thread_ref, provider_message_id, body, occurred_at,
                                     intent, intent_confidence, intent_source, classified_at)
       VALUES ($1, $2, $3, 'inbound', 'email', 'hilo-3', 'resp-ooo-1', 'Hola. Estoy fuera y vuelvo el 6 de octubre.', '2026-09-24T14:00:00Z',
               'ambiguous', 0.4, 'model', now()),
              ($4, $2, $3, 'inbound', 'email', 'hilo-3', 'resp-ooo-2', 'Hola. Estoy fuera unos días.', '2026-09-24T14:30:00Z',
               'ambiguous', 0.4, 'model', now())`,
      [OOO, WS_A, CONTACT_3, OOO2],
    ),
  );
  const leida = await t.db.withWorkspace(WS_A, (tx) => reclassifyInboxMessage(tx, { messageId: OOO, intent: 'ooo', now }));
  assert.equal(leida.ok, true);
  const escrita = await t.db.withWorkspace(WS_A, (tx) =>
    reclassifyInboxMessage(tx, { messageId: OOO2, intent: 'ooo', now, returnDate: '2026-10-20' }),
  );
  assert.equal(escrita.ok, true);
  const conv = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT_3, 'email')))!;
  const vuelve = (mid: string) => conv.messages.find((m) => m.id === mid)!.resumeAt?.toISOString();
  // El comienzo del día de vuelta en Bogotá (UTC-5), no los siete días por defecto.
  assert.equal(vuelve(OOO), '2026-10-06T05:00:00.000Z', 'la fecha del mensaje');
  assert.equal(vuelve(OOO2), '2026-10-20T05:00:00.000Z', 'la fecha que escribió la persona');
});

test('el estado del clasificador sale de la última corrida de outbound.intent', async () => {
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => outreachClassifierStatus(tx)), 'unknown');
  await t.admin(`INSERT INTO job_run (job_id, status, started_at, finished_at, metadata)
                 VALUES ('outbound.intent', 'ok', now(), now(), '{"notConfigured": true, "classifier": null}'::jsonb)`);
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => outreachClassifierStatus(tx)), 'off');
  await t.admin(`INSERT INTO job_run (job_id, status, started_at, finished_at, metadata)
                 VALUES ('outbound.intent', 'ok', now() + interval '1 second', now(), '{"notConfigured": false, "classifier": "model"}'::jsonb)`);
  assert.equal(await t.db.withWorkspace(WS_B, (tx) => outreachClassifierStatus(tx)), 'model');
});

test('«Editar» una respuesta en cola la devuelve al campo sin dejarla además en «no salió»', async () => {
  const now = new Date();
  const touchId = id('94');
  const r = await t.db.withWorkspace(WS_A, (tx) =>
    replyInInboxThread(tx, { touchId, contactId: CONTACT, channel: 'email', body: 'Para corregir', userId: null, now }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => cancelInboxReply(tx, touchId, { dismissAt: now })), { ok: true, body: 'Para corregir' },
  );
  const conv = (await t.db.withWorkspace(WS_A, (tx) => loadInboxConversation(tx, CONTACT, 'email')))!;
  assert.ok(!conv.pending.some((p) => p.touchId === touchId), 'no sale');
  assert.ok(!conv.notSent.some((p) => p.touchId === touchId), 'y no se ve dos veces: el texto está en «Tu respuesta»');
  const fila = (await t.db.asWorker((tx) =>
    tx.query<{ status: string; blocked_reason: string }>(`SELECT status, blocked_reason FROM outbound_touch WHERE id = $1`, [touchId]),
  )).rows[0]!;
  assert.deepEqual([fila.status, fila.blocked_reason], ['canceled', 'canceled_by_person']);
});

test('como mc_app: corregir a «interesada» la respuesta de una marca sin negocio abre uno en «En conversación», en su espacio', async () => {
  const now = new Date();
  const r = await t.db.withWorkspace(WS_B, (tx) => reclassifyInboxMessage(tx, { messageId: INBOUND_B, intent: 'interested', now }));
  assert.equal(r.ok && r.dealMoved, true);
  const deals = (await t.db.asWorker((tx) =>
    tx.query<{ workspace_id: string; stage_id: string; next_action: string; history: number }>(
      `SELECT workspace_id, stage_id, next_action,
              (SELECT count(*)::int FROM deal_stage_history h WHERE h.deal_id = d.id) AS history
         FROM deal d WHERE company_id = $1`,
      [CO_B],
    ),
  )).rows;
  assert.deepEqual(deals.map((d) => [d.workspace_id, d.stage_id, d.next_action, d.history]), [[WS_B, 'conversacion', 'Responder hoy', 1]]);
  const conv = (await t.db.withWorkspace(WS_B, (tx) => loadInboxConversation(tx, CONTACT_B, 'email')))!;
  assert.equal(conv.deal?.stageId, 'conversacion');
  // Una segunda corrección no abre otro: ya hay uno abierto con la marca.
  await t.db.withWorkspace(WS_B, (tx) => reclassifyInboxMessage(tx, { messageId: INBOUND_B, intent: 'interested', now }));
  const n = (await t.db.asWorker((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM deal WHERE company_id = $1`, [CO_B]))).rows[0]!.n;
  assert.equal(n, 1);
});

test('un borrador regenerado que no se puede aprobar tal cual sigue siendo el borrador de antes: ni retenido ni sin su «Versión nueva»', async () => {
  const now = new Date();
  const SEQ = id('5e2');
  const ENR = id('e2');
  const NUEVO = id('76');
  const MARIA = id('d9');
  await t.admin(`
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${MARIA}', '${CO}', '${WS_A}', 'María Vitalé', 'maria@vitale.test', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel) VALUES ('${SEQ}', '${WS_A}', 'Regenerados', 'email');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status) VALUES ('${ENR}', '${WS_A}', '${SEQ}', '${MARIA}', 'active');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, enrollment_id, channel, subject, body, status) VALUES
      ('${NUEVO}', '${WS_A}', '${CO}', '${MARIA}', '${SEQ}', '${ENR}', 'email', 'Versión nueva', 'Hola, {{first_name}}: otra versión.', 'draft');
    INSERT INTO outbound_generation (touch_id, workspace_id, requested_at, stage) VALUES ('${NUEVO}', '${WS_A}', now(), 'failed');
  `);
  const antes = await t.db.withWorkspace(WS_A, (tx) =>
    tx.query<{ status_changed_at: Date }>('SELECT status_changed_at FROM outbound_touch WHERE id = $1', [NUEVO]),
  );
  assert.deepEqual(
    await t.db.withWorkspace(WS_A, (tx) => approveQueuedTouch(tx, { touchId: NUEVO, userId: null, now })),
    { ok: false, code: 'placeholders', detail: '{{first_name}}' },
  );
  const fila = await t.db.withWorkspace(WS_A, (tx) =>
    tx.query<{ status: string; held_reason: string | null; approved_from_reason: string | null; status_changed_at: Date }>(
      'SELECT status, held_reason, approved_from_reason, status_changed_at FROM outbound_touch WHERE id = $1', [NUEVO],
    ),
  );
  assert.deepEqual(
    [fila.rows[0]!.status, fila.rows[0]!.held_reason, fila.rows[0]!.approved_from_reason], ['draft', null, null],
    'el paso a retenido se deshace con la aprobación que no fue',
  );
  assert.equal(new Date(fila.rows[0]!.status_changed_at).getTime(), new Date(antes.rows[0]!.status_changed_at).getTime());
  const cola = await t.db.withWorkspace(WS_A, (tx) => listApprovalQueue(tx));
  const item = cola.items.find((x) => x.touchId === NUEVO)!;
  assert.deepEqual([item.status, item.regenerating, item.heldReason], ['draft', false, null], 'sigue en la cola como versión nueva');
  // Con el hueco rellenado, sí: y el motivo de la aprobación es la revisión humana del borrador.
  const ok = await t.db.withWorkspace(WS_A, (tx) =>
    approveQueuedTouch(tx, { touchId: NUEVO, body: 'Hola, María: otra versión.', userId: null, now }),
  );
  assert.equal(ok.ok, true);
  const aprobado = await t.db.withWorkspace(WS_A, (tx) =>
    tx.query<{ status: string; approved_from_reason: string | null }>('SELECT status, approved_from_reason FROM outbound_touch WHERE id = $1', [NUEVO]),
  );
  assert.deepEqual([aprobado.rows[0]!.status, aprobado.rows[0]!.approved_from_reason], ['scheduled', 'needs_review']);
});

test('«Deshacer» devuelve el mensaje a su lugar en la cola, no al final', async () => {
  const PRIMERO = id('7a');
  const SEGUNDO = id('7b');
  await t.admin(`
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, held_reason, created_at) VALUES
      ('${PRIMERO}', '${WS_A}', '${CO}', '${CONTACT}', 'email', 'Uno', 'El primero en la cola.', 'held', 'needs_review', now() - interval '1 hour'),
      ('${SEGUNDO}', '${WS_A}', '${CO}', '${CONTACT}', 'email', 'Dos', 'El segundo en la cola.', 'held', 'needs_review', now() - interval '30 minutes');
  `);
  const orden = async () =>
    (await t.db.withWorkspace(WS_A, (tx) => listApprovalQueue(tx))).items.map((x) => x.touchId).filter((x) => x === PRIMERO || x === SEGUNDO);
  assert.deepEqual(await orden(), [PRIMERO, SEGUNDO]);
  const r = await t.db.withWorkspace(WS_A, (tx) => approveQueuedTouch(tx, { touchId: PRIMERO, userId: null, now: new Date() }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(await orden(), [SEGUNDO]);
  assert.equal((await t.db.withWorkspace(WS_A, (tx) => undoApproval(tx, { touchId: PRIMERO, approvedAt: r.approvedAt }))).ok, true);
  assert.deepEqual(await orden(), [PRIMERO, SEGUNDO], 'vuelve delante, donde estaba');
});
