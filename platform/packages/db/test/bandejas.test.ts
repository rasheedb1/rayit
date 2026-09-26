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
  approveQueuedTouch, createReferralContact, listApprovalQueue, listInboxThreads, loadInboxConversation, markInboxThreadRead,
  replyInInboxThread, skipQueuedTouch,
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
           ('${CONTACT_B}', '${CO_B}', '${WS_B}', 'Pedro Otro', 'pedro@otra.test', 'user_provided');
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
              ($6, $7, NULL, $8, 'inbound', 'email', 'hilo-b', 'resp-b', NULL, 'Hola desde B', now(), NULL, NULL, NULL, NULL, NULL)`,
      [OUTBOUND_MSG, WS_A, SENT, CONTACT, INBOUND, INBOUND_B, WS_B, CONTACT_B],
    );
  });
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

test('la cola, los hilos y la conversación son del espacio que mira', async () => {
  const cola = await t.db.withWorkspace(WS_A, (tx) => listApprovalQueue(tx));
  assert.deepEqual(cola.map((x) => [x.touchId, x.heldReason]), [[HELD, 'needs_review'], [HELD2, 'quality_warmup:3']]);
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => listApprovalQueue(tx)), []);

  const hilos = await t.db.withWorkspace(WS_A, (tx) => listInboxThreads(tx));
  assert.deepEqual(hilos.map((h) => [h.contactId, h.unread, h.lastIntent]), [[CONTACT, 1, 'referral']]);
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
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => approveQueuedTouch(tx, { touchId: HELD, userId: null, now })), { ok: true });
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => skipQueuedTouch(tx, HELD2, now)), { ok: true });
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => markInboxThreadRead(tx, CONTACT, 'email', now)), 1);
  const touchId = id('98');
  const responder = () =>
    t.db.withWorkspace(WS_A, (tx) =>
      replyInInboxThread(tx, { touchId, contactId: CONTACT, channel: 'email', body: 'Gracias, le escribo a Ana.', userId: null, now }),
    );
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: false });
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: true });
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
