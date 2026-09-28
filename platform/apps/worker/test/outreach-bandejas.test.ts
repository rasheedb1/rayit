/**
 * VEN-14 · las bandejas y la intención de las respuestas, de punta a
 * punta en Postgres embebido, con el canal falso, el clasificador falso
 * (o un modelo guionizado) y un reloj falso. Sin red ni llave.
 *
 * Lo que pide la historia («terminado cuando»):
 *   · un toque retenido se aprueba desde la bandeja, queda 'scheduled' y
 *     el despachador lo envía;
 *   · una respuesta «me interesa» (fixture) mueve el negocio a «En
 *     conversación» con «Responder hoy», aparece en la bandeja con la
 *     conversación completa, y la respuesta escrita ahí sale por el motor
 *     en el mismo hilo, una sola vez;
 *   · una respuesta de baja marca a la ficha y cancela lo pendiente, la vea
 *     el detector o el modelo.
 *
 * Y el resto de §5.7: «ahora no» enfría noventa días y vuelve a la
 * bandeja de aprobación; «fuera de la oficina» pausa hasta la fecha y
 * vuelve; un referido se propone y se crea a mano; lo dudoso lo lee una
 * persona; sin clasificador no se clasifica nada.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFakeIntentClassifier, LlmIntentClassifier, type IntentClassifier, type IntentInput } from '@mc/core/outreach/intent';
import type { LlmClient } from '@mc/core/outreach/llm';
import { llmCostUsd } from '@mc/core/outreach/llm-precios';
import {
  approveQueuedTouch, cancelInboxReply, createReferralContact, listApprovalQueue, listInboxThreads, loadInboxConversation,
  markInboxThreadRead, reclassifyInboxMessage, regenerateQueuedTouch, replyInInboxThread, skipQueuedTouch,
} from '@mc/db/queries/bandejas';
import { type applyIntent, enrollContacts, INTENT_MAX_ATTEMPTS } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runGenerate } from '../src/jobs/ventas/outbound.generate.ts';
import { runReview } from '../src/jobs/ventas/outbound.review.ts';
import { runIntent } from '../src/jobs/ventas/outbound.intent.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromClient, motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, motorKit, type Ws } from './helpers/motor-kit.ts';

/** Las respuestas grabadas (fixtures/respuestas/marcas.json). */
const F = JSON.parse(readFileSync(new URL('./fixtures/respuestas/marcas.json', import.meta.url), 'utf8')) as Record<
  string,
  { body: string; intent: string }
>;

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, comoLaWeb } = motorKit({
  db: () => db, motor: () => motor, prefix: '00000114', slug: 'bandejas',
});

const fakeClassifier = createFakeIntentClassifier();

/** Un modelo guionizado: responde siempre lo mismo, con tokens de verdad. */
function scriptedModel(answer: string): LlmClient {
  return {
    name: 'guion',
    async complete(req) {
      return { text: answer, model: req.model, inputTokens: 640, outputTokens: 38, costUsd: Number(llmCostUsd({ model: req.model, inputTokens: 640, outputTokens: 38 })), stopReason: 'end_turn' };
    },
  };
}

/** Un negocio abierto de la marca del workspace, en «Contactado». */
async function negocio(w: Ws): Promise<string> {
  return scalar<string>(
    `INSERT INTO deal (workspace_id, company_id, name, stage_id) VALUES ($1, $2, 'Temporada de fin de año', 'contactado') RETURNING id AS v`,
    [w.id, w.company],
  );
}

/**
 * Enrola a la primera ficha (con el negocio, si hay), envía el primer
 * correo y deja la respuesta de la marca leída por el lector del motor.
 * Devuelve el hilo y la ficha.
 */
async function conversacion(
  w: Ws, body: string, opts: { deal?: string; at?: Date; automatic?: boolean; from?: string } = {},
): Promise<{ contact: string; thread: string; fake: ReturnType<typeof fakeChannels> }> {
  const contact = w.contacts[0]!;
  await motor.transaction((tx) =>
    enrollContacts(tx, { sequenceId: w.seq, contactIds: [contact], dealId: opts.deal ?? null, now: bogota('2026-09-23', '07:00') }),
  );
  const fake = fakeChannels();
  const sent = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(sent.sent.length, 1, 'salió el primer correo');
  const thread = fake.email.sent[0]!.threadRef;
  const at = opts.at ?? bogota('2026-09-23', '15:00');
  fake.email.reply(thread, body, at, opts.from, { automatic: opts.automatic === true });
  await runReplies(motor, { readers: fake, now: () => new Date(at.getTime() + 5 * 60_000), workspaceId: w.id });
  return { contact, thread, fake };
}

test('terminado cuando: un retenido se aprueba desde la bandeja, queda programado y sale; editar y saltar', async () => {
  const w = await workspace(1, { contacts: 1, humanReview: true });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const [primero, segundo, tercero] = await touches(c);
  assert.deepEqual([primero!.status, primero!.held_reason], ['held', 'needs_review'], 'la revisión humana retiene');

  const { items: cola, total } = await comoLaWeb(w.id, (tx) => listApprovalQueue(tx));
  assert.deepEqual(cola.map((x) => x.touchId), [primero!.id, segundo!.id, tercero!.id]);
  assert.equal(total, 3);
  const item = cola[0]!;
  assert.equal(item.companyName, 'Marca 1');
  assert.equal(item.contactName, 'Persona 1 Prueba');
  assert.deepEqual([item.stepIndex, item.stepCount, item.channel], [1, 3, 'email']);
  assert.equal(item.subject, 'Hola, Persona');
  assert.equal(item.heldReason, 'needs_review');
  assert.equal(item.regenerable, true, 'un correo se puede regenerar');
  assert.equal(cola[1]!.regenerable, true, 'un seguimiento en el hilo (email_reply) también');
  // Lo ajeno (otro espacio no ve ni aprueba) se prueba con la RLS de verdad en packages/db/test/bandejas.test.ts.

  // Aprobar tal cual: queda programado, con quién y cuándo. El envío del espacio está encendido (sendingOff: false).
  const ahora = bogota('2026-09-23', '08:00');
  assert.deepEqual(await comoLaWeb(w.id, (tx) => approveQueuedTouch(tx, { touchId: primero!.id, userId: null, now: ahora })), {
    ok: true, approvedAt: ahora, sendingOff: false, recipientName: 'Persona 1 Prueba',
  });
  // Editar y aprobar: sale lo que dejó la persona; lo que rompe una regla no se aprueba.
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) => approveQueuedTouch(tx, { touchId: segundo!.id, body: 'Hola, {{first_name}}', userId: null, now: ahora })),
    { ok: false, code: 'placeholders', detail: '{{first_name}}' },
  );
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) =>
      approveQueuedTouch(tx, { touchId: segundo!.id, subject: null, body: 'Te dejo una idea concreta para la temporada.', userId: null, now: ahora }),
    ),
    { ok: true, approvedAt: ahora, sendingOff: false, recipientName: 'Persona 1 Prueba' },
  );
  // Saltar: el tercero no sale y no frena a nadie.
  assert.deepEqual(await comoLaWeb(w.id, (tx) => skipQueuedTouch(tx, tercero!.id, ahora)), { ok: true, recipientName: 'Persona 1 Prueba' });
  assert.deepEqual(await comoLaWeb(w.id, (tx) => skipQueuedTouch(tx, tercero!.id, ahora)), { ok: false, code: 'not_skippable' });

  const despues = await touches(c);
  assert.deepEqual(despues.map((x) => x.status), ['scheduled', 'scheduled', 'skipped']);
  assert.equal(await scalar<boolean>('SELECT approved_at IS NOT NULL AS v FROM outbound_touch WHERE id = $1', [primero!.id]), true);
  assert.deepEqual(await comoLaWeb(w.id, (tx) => listApprovalQueue(tx)), { items: [], total: 0 }, 'la cola queda vacía');

  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1, 'el aprobado sale');
  assert.equal(fake.email.sent[0]!.touchId, primero!.id);
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '12:00')));
  assert.equal(r2.sent.length, 1);
  assert.equal(fake.email.sent[1]!.content, 'Te dejo una idea concreta para la temporada.', 'sale el texto editado, en el hilo');
  assert.equal(fake.email.sent[1]!.reply?.threadRef, fake.email.sent[0]!.threadRef);
});

test('terminado cuando: «me interesa» mueve el negocio, aparece en la bandeja con la conversación y la respuesta sale una vez', async () => {
  // Con tres días entre mensajes a la marca: escribir en frío espera; responder a quien escribió, no.
  const w = await workspace(3, { contacts: 1, minDaysBetweenTouches: 3 });
  const deal = await negocio(w);
  assert.equal(F.me_interesa!.intent, 'interested');
  const { contact, thread, fake } = await conversacion(w, F.me_interesa!.body, { deal });

  const rep = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.deepEqual(rep.classified.map((c) => [c.intent, c.dealMoved]), [['interested', true]]);
  assert.equal(rep.notConfigured, false);

  const d = (await db.raw.query<{ stage_id: string; next_action: string; due: string; history: number }>(
    `SELECT stage_id, next_action, to_char(next_action_due AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS due,
            (SELECT count(*)::int FROM deal_stage_history h WHERE h.deal_id = deal.id AND h.to_stage_id = 'conversacion') AS history
       FROM deal WHERE id = $1`, [deal],
  )).rows[0]!;
  assert.equal(d.stage_id, 'conversacion', 'el negocio pasa a «En conversación»');
  assert.equal(d.next_action, 'Responder hoy');
  assert.equal(d.due, '2026-09-23 23:59', 'vence al final del día local');
  assert.equal(d.history, 1, 'con su historial de etapa');
  const aviso = (await db.raw.query<{ title_es: string; action_url: string; severity: string }>(
    `SELECT title_es, action_url, severity FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_message_intent'`, [w.id],
  )).rows;
  assert.equal(aviso.length, 1);
  assert.equal(aviso[0]!.title_es, 'Persona 1 Prueba quiere seguir la conversación');
  assert.equal(aviso[0]!.action_url, `/ventas/bandeja?contacto=${contact}&canal=email`);

  // Una segunda corrida no vuelve a clasificar ni a avisar.
  const otra = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:09'), workspaceId: w.id });
  assert.equal(otra.classified.length, 0);

  // La bandeja: el hilo sin leer arriba, con la intención; la conversación completa, en orden.
  const hilos = await comoLaWeb(w.id, (tx) => listInboxThreads(tx));
  assert.deepEqual(hilos.map((h) => [h.contactId, h.channel, h.unread, h.lastIntent, h.lastDirection]), [
    [contact, 'email', 1, 'interested', 'inbound'],
  ]);
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  assert.deepEqual(conv.messages.map((m) => m.direction), ['outbound', 'inbound']);
  assert.equal(conv.messages[0]!.body, 'Hola, Persona: te escribo por Marca 3.');
  assert.equal(conv.messages[1]!.body, F.me_interesa!.body);
  assert.deepEqual([conv.messages[1]!.intent, conv.messages[1]!.intentSource], ['interested', 'fake']);
  assert.equal(conv.deal?.stageId, 'conversacion');
  assert.equal(conv.replyBlock, null);
  assert.equal(await comoLaWeb(w.id, (tx) => markInboxThreadRead(tx, contact, 'email', bogota('2026-09-23', '15:10'))), 1);
  assert.equal((await comoLaWeb(w.id, (tx) => listInboxThreads(tx)))[0]!.unread, 0);

  // Responder desde la bandeja: un toque, aunque el formulario llegue dos veces.
  const touchId = randomUUID();
  const responder = () =>
    comoLaWeb(w.id, (tx) =>
      replyInInboxThread(tx, {
        touchId, contactId: contact, channel: 'email', body: '¡Qué bien! El jueves a las 10 me sirve. Te mando las tarifas hoy.',
        userId: null, now: bogota('2026-09-23', '15:12'),
      }),
    );
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: false, sendingOff: false });
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: true, sendingOff: false });
  assert.equal(await scalar<number>('SELECT count(*)::int AS v FROM outbound_touch WHERE reply_to_message_id IS NOT NULL AND contact_id = $1', [contact]), 1);
  assert.equal((await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!.pending.length, 1, 'se ve «enviando»');

  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:14')));
  assert.deepEqual(r.sent, [touchId], 'sale por el motor, sin esperar los días entre mensajes a la marca');
  const salida = fake.email.sent.at(-1)!;
  assert.equal(salida.reply?.threadRef, thread, 'en el mismo hilo');
  assert.equal(salida.subject, 'Re: Hola, Persona');
  assert.equal(salida.account.id, w.gmail, 'por la cuenta que recibió el mensaje');
  assert.ok(salida.body.includes('Calle 93'), 'con el pie de baja del correo');
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:20')));
  assert.deepEqual(r2.sent, [], 'una sola vez');

  const final = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  assert.deepEqual(final.messages.map((m) => m.direction), ['outbound', 'inbound', 'outbound']);
  assert.deepEqual(final.pending, []);
});

/**
 * Un pitch programado a la misma ficha fuera de la cadencia, desde hace una
 * hora (antes de que llegue la respuesta): cualquier respuesta de la ficha
 * lo detiene y una persona decide.
 */
async function pitchPendiente(w: Ws, contact: string): Promise<string> {
  return scalar<string>(
    `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for, created_at)
     VALUES ($1, $2, $3, 'email', 'Otra idea', 'Te escribo con otra idea.', 'scheduled', now() + interval '3 days', now() - interval '1 hour')
     RETURNING id AS v`,
    [w.id, w.company, contact],
  );
}

test('terminado cuando: una baja marca a la ficha y cancela lo pendiente, la vea el detector o el modelo', async () => {
  // El detector de VEN-10: la baja explícita llega ya clasificada y el job no la vuelve a pagar.
  const a = await workspace(4, { contacts: 1 });
  const pitchA = await pitchPendiente(a, a.contacts[0]!);
  const { contact: ca } = await conversacion(a, F.baja_explicita!.body);
  const conModelo = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.99,"return_date":null,"referral":null,"reason":""}'));
  const r1 = await runIntent(motor, { classifier: conModelo, now: () => bogota('2026-09-23', '15:06'), workspaceId: a.id });
  assert.equal(r1.classified.length, 0, 'ya estaba clasificada');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_llm_call WHERE workspace_id = $1`, [a.id]), 0);
  const ma = (await db.raw.query<{ intent: string; intent_source: string }>(
    `SELECT intent, intent_source FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [ca],
  )).rows[0]!;
  assert.deepEqual([ma.intent, ma.intent_source], ['unsubscribe', 'detector']);
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [ca]), true);
  assert.equal(await scalar<string>('SELECT status || \':\' || blocked_reason AS v FROM outbound_touch WHERE id = $1', [pitchA]), 'canceled:opted_out');

  // La que el detector no ve: la respuesta detiene la cadencia y el modelo la clasifica como baja.
  const b = await workspace(5, { contacts: 1 });
  const pitchB = await pitchPendiente(b, b.contacts[0]!);
  const { contact: cb } = await conversacion(b, F.baja_implicita!.body);
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [cb]), false, 'el detector no la vio');
  assert.equal(
    await scalar<string>("SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE id = $1", [pitchB]), 'canceled:replied',
    'la respuesta ya detuvo el pitch suelto',
  );
  const baja = new LlmIntentClassifier(scriptedModel('{"intent":"unsubscribe","confidence":0.93,"return_date":null,"referral":null,"reason":"No quiere más propuestas."}'));
  const r2 = await runIntent(motor, { classifier: baja, now: () => bogota('2026-09-23', '15:06'), workspaceId: b.id });
  assert.deepEqual(r2.classified.map((c) => c.intent), ['unsubscribe']);
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [cb]), true, 'la ficha queda de baja');
  assert.equal(await scalar<string>('SELECT opted_out_code AS v FROM contact WHERE id = $1', [cb]), 'reply_optout:email');
  assert.equal(await scalar<string>('SELECT status || \':\' || blocked_reason AS v FROM outbound_touch WHERE id = $1', [pitchB]), 'canceled:replied', 'sigue cancelado');
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE contact_id = $1 AND status IN ('draft', 'scheduled', 'held')`, [cb]), 0,
    'nada pendiente',
  );
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [cb]), 'opted_out');
  const llamada = (await db.raw.query<{ purpose: string; model: string; input_tokens: number; cost: string; tied: boolean }>(
    `SELECT purpose, model, input_tokens, cost::text AS cost, message_id IS NOT NULL AS tied FROM outbound_llm_call WHERE workspace_id = $1`, [b.id],
  )).rows;
  assert.deepEqual(llamada.map((l) => [l.purpose, l.model, l.input_tokens, l.tied]), [['classify', 'claude-haiku-4-5-20251001', 640, true]]);
  assert.equal(Number(llamada[0]!.cost), Number(llmCostUsd({ model: 'claude-haiku-4-5-20251001', inputTokens: 640, outputTokens: 38 })), 'con su costo');
  const origen = await scalar<string>(`SELECT intent_source AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [cb]);
  assert.equal(origen, 'model');
});

test('«ahora no»: noventa días de enfriamiento, y al terminar la cadencia vuelve a la bandeja de aprobación, sin enviar sola', async () => {
  const w = await workspace(6, { contacts: 1 });
  const { contact } = await conversacion(w, F.ahora_no!.body);
  const r = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.deepEqual(r.classified.map((c) => c.intent), ['not_now']);
  const e = (await db.raw.query<{ status: string; resume: string }>(
    `SELECT status, to_char(resume_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS resume FROM outbound_enrollment WHERE contact_id = $1`, [contact],
  )).rows[0]!;
  assert.deepEqual([e.status, e.resume], ['cooldown', '2026-12-22 20:00'], 'noventa días desde la respuesta');
  assert.equal(
    await scalar<string>(`SELECT body_es AS v FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_message_intent'`, [w.id]),
    'La cadencia se enfría hasta el 22 de diciembre de 2026. Ese día vuelve a tu bandeja de aprobación, sin enviar nada por su cuenta.',
  );

  // Antes de la fecha no pasa nada.
  const antes = await runIntent(motor, { classifier: null, now: () => bogota('2026-12-01', '10:00'), workspaceId: w.id });
  assert.deepEqual(antes.resumed.cooldownBack, []);
  // Al terminar: los dos pasos que la respuesta canceló vuelven retenidos, replanificados desde hoy.
  const despues = await runIntent(motor, { classifier: null, now: () => bogota('2026-12-23', '10:00'), workspaceId: w.id });
  assert.equal(despues.notConfigured, true);
  assert.deepEqual(despues.resumed.cooldownBack.map((x) => x.touches), [2]);
  const vuelta = await touches(contact);
  assert.deepEqual(vuelta.map((t) => [t.status, t.held_reason]), [['sent', null], ['held', 'cooldown_over'], ['held', 'cooldown_over']]);
  assert.ok(vuelta[1]!.scheduled_for >= bogota('2026-12-23', '09:00'), 'desde hoy, no en el pasado');
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), 'active');
  const cola = await comoLaWeb(w.id, (tx) => listApprovalQueue(tx));
  assert.deepEqual(cola.items.map((x) => x.heldReason), ['cooldown_over', 'cooldown_over']);
  const fake = fakeChannels();
  const sale = await runDispatch(motor, deps(w, fake, () => bogota('2026-12-24', '12:00')));
  assert.deepEqual(sale.sent, [], 'nada sale sin que una persona lo apruebe');
});

test('«fuera de la oficina»: la cadencia espera a la fecha de vuelta y sigue; con o sin cabecera automática', async () => {
  // Sin cabecera (como en LinkedIn): la respuesta detuvo la cadencia; la intención la devuelve.
  const w = await workspace(7, { contacts: 1 });
  const { contact } = await conversacion(w, F.fuera_de_oficina!.body);
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), 'replied');
  await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  const m = (await db.raw.query<{ intent: string; resume: string }>(
    `SELECT intent, to_char(resume_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS resume FROM outbound_message
      WHERE contact_id = $1 AND direction = 'inbound'`, [contact],
  )).rows[0]!;
  assert.deepEqual([m.intent, m.resume], ['ooo', '2026-10-06 00:00']);
  const e = await scalar<string>(`SELECT status || ':' || to_char(resume_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS v FROM outbound_enrollment WHERE contact_id = $1`, [contact]);
  assert.equal(e, 'paused:2026-10-06');
  const vuelta = await touches(contact);
  assert.deepEqual(vuelta.map((t) => t.status), ['sent', 'scheduled', 'scheduled'], 'lo que la respuesta canceló vuelve a la cola');
  assert.ok(vuelta[1]!.scheduled_for >= bogota('2026-10-06', '09:00'), 'desde la fecha de vuelta');
  assert.equal(await scalar<boolean>(`SELECT replied_at IS NULL AS v FROM outbound_touch WHERE id = $1`, [vuelta[0]!.id]), true, 'no cuenta como respondido');
  const reanuda = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-10-06', '08:00'), workspaceId: w.id });
  assert.equal(reanuda.resumed.resumed.length, 1);
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), 'active');

  // Con cabecera automática: la cadencia no se detuvo; queda en pausa hasta la fecha.
  const w2 = await workspace(8, { contacts: 1 });
  const { contact: c2 } = await conversacion(w2, 'Gracias por tu correo. Estoy de vacaciones hasta el 2026-10-02.', { automatic: true });
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [c2]), 'active');
  await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w2.id });
  assert.equal(
    await scalar<string>(`SELECT status || ':' || to_char(resume_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS v FROM outbound_enrollment WHERE contact_id = $1`, [c2]),
    'paused:2026-10-02',
  );
  const fake = fakeChannels();
  const espera = await runDispatch(motor, deps(w2, fake, () => bogota('2026-09-24', '12:00')));
  assert.deepEqual(espera.sent, [], 'mientras está fuera, nada sale');
});

test('un referido se propone y una persona lo crea; lo dudoso lo lee una persona; una respuesta ilegible no se paga en bucle', async () => {
  const w = await workspace(9, { contacts: 1 });
  const { contact } = await conversacion(w, F.referido!.body);
  await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  const entrante = conv.messages.find((x) => x.direction === 'inbound')!;
  assert.equal(entrante.intent, 'referral');
  assert.deepEqual(entrante.referral, { name: 'Ana Gómez', email: 'ana.gomez@marca.test', role: null });
  assert.equal(
    await scalar<string>(`SELECT title_es AS v FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_message_intent'`, [w.id]),
    'Persona 1 Prueba te remite a otra persona',
  );
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM contact WHERE email = 'ana.gomez@marca.test'`), 0, 'nada se crea solo');
  const creado = await comoLaWeb(w.id, (tx) =>
    createReferralContact(tx, { messageId: entrante.id, fullName: 'Ana Gómez', email: 'ana.gomez@marca.test', roleTitle: 'Mercadeo' }),
  );
  assert.equal(creado.ok, true);
  const ficha = (await db.raw.query<{ company_id: string; source: string }>(
    `SELECT company_id, source FROM contact WHERE email = 'ana.gomez@marca.test'`,
  )).rows[0]!;
  assert.deepEqual([ficha.company_id, ficha.source], [w.company, 'inbound']);
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) => createReferralContact(tx, { messageId: entrante.id, fullName: 'Ana', email: null, roleTitle: null })),
    { ok: false, code: 'already_created' },
  );

  // Dudosa (el modelo no llega a 0,7) y otra ilegible: las dos quedan para una persona; la ilegible se registra igual.
  const w2 = await workspace(10, { contacts: 1 });
  const { contact: c2 } = await conversacion(w2, F.ambigua!.body);
  const dudoso = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.55,"return_date":null,"referral":null,"reason":"Solo dice ok."}'));
  await runIntent(motor, { classifier: dudoso, now: () => bogota('2026-09-23', '15:06'), workspaceId: w2.id });
  assert.equal(await scalar<string>(`SELECT intent AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [c2]), 'ambiguous');
  assert.equal(
    await scalar<string>(`SELECT severity AS v FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_message_intent'`, [w2.id]),
    'warning',
  );
  const w3 = await workspace(11, { contacts: 1 });
  const { contact: c3 } = await conversacion(w3, F.ambigua!.body);
  const roto = new LlmIntentClassifier(scriptedModel('esto no es json'));
  const r = await runIntent(motor, { classifier: roto, now: () => bogota('2026-09-23', '15:06'), workspaceId: w3.id });
  assert.equal(r.unreadable.length, 1);
  assert.equal(await scalar<string>(`SELECT intent || ':' || intent_confidence AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [c3]), 'ambiguous:0.000');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_llm_call WHERE workspace_id = $1 AND purpose = 'classify'`, [w3.id]), 1);
  const otra = await runIntent(motor, { classifier: roto, now: () => bogota('2026-09-23', '15:09'), workspaceId: w3.id });
  assert.equal(otra.classified.length, 0, 'no se vuelve a pagar');
});

test('sin clasificador no se clasifica nada, y sin presupuesto se espera', async () => {
  const w = await workspace(12, { contacts: 1 });
  const { contact } = await conversacion(w, F.me_interesa!.body);
  const r = await runIntent(motor, { classifier: null, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.equal(r.notConfigured, true);
  assert.equal(await scalar<boolean>(`SELECT classified_at IS NULL AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [contact]), true);
  await db.raw.query(`UPDATE outbound_policy SET llm_daily_cap_usd = 0 WHERE workspace_id = $1`, [w.id]);
  const modelo = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.9,"return_date":null,"referral":null,"reason":""}'));
  const sinPlata = await runIntent(motor, { classifier: modelo, now: () => bogota('2026-09-23', '15:09'), workspaceId: w.id });
  assert.equal(sinPlata.overBudget.length, 1);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_llm_call WHERE workspace_id = $1`, [w.id]), 0);
});

/** Un mensaje entrante sin clasificar escrito a mano, como lo deja el lector. */
async function entrante(w: Ws, body: string, n: number): Promise<string> {
  return scalar<string>(
    `INSERT INTO outbound_message (workspace_id, contact_id, direction, channel, thread_ref, provider_message_id, body, occurred_at, created_at)
     VALUES ($1, $2, 'inbound', 'email', 'hilo-' || $3, 'resp-' || gen_random_uuid()::text, $4, now() - ($3 || ' minutes')::interval,
             now() - ($3 || ' minutes')::interval)
     RETURNING id AS v`,
    [w.id, w.contacts[0], String(n), body],
  );
}

test('el lote se reparte entre workspaces: uno sin presupuesto y con 25 respuestas no deja a otro sin clasificar', async () => {
  const a = await workspace(20, { contacts: 1 });
  const b = await workspace(21, { contacts: 1 });
  await db.raw.query(`UPDATE outbound_policy SET llm_daily_cap_usd = 0 WHERE workspace_id = $1`, [a.id]);
  // Las de A son más viejas: con el lote global de antes ocupaban los 20 puestos.
  for (let i = 0; i < 25; i++) await entrante(a, `Respuesta ${i} de A`, 100 + i);
  const deB = await entrante(b, 'Me interesa, mándame tarifas.', 1);
  const modelo = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.92,"return_date":null,"referral":null,"reason":"Pide tarifas."}'));
  const r = await runIntent(motor, { classifier: modelo, now: () => new Date() });
  assert.ok(r.classified.some((c) => c.messageId === deB), 'B se clasifica en la misma corrida');
  assert.ok(r.overBudget.includes(a.id), 'A espera a mañana');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_llm_call WHERE workspace_id = $1`, [a.id]), 0, 'A no gasta');
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_message WHERE workspace_id = $1 AND classified_at IS NULL`, [a.id]), 25,
  );
  assert.equal(await scalar<string>(`SELECT intent_reason AS v FROM outbound_message WHERE id = $1`, [deB]), 'Pide tarifas.', 'con su razón');
});

test('si aplicar los efectos falla, la clasificación no se vuelve a pagar; al tercer fallo queda para una persona', async () => {
  const w = await workspace(22, { contacts: 1 });
  const m = await entrante(w, 'Me interesa, ¿hablamos el jueves?', 1);
  const modelo = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.9,"return_date":null,"referral":null,"reason":"Quiere hablar."}'));
  const rompe: typeof applyIntent = async () => {
    throw new Error('deadlock simulado');
  };
  const correr = (apply?: typeof applyIntent) =>
    runIntent(motor, { classifier: modelo, now: () => new Date(), workspaceId: w.id, ...(apply ? { apply } : {}) });
  const r1 = await correr(rompe);
  assert.equal(r1.errors.length, 1);
  const r2 = await correr(rompe);
  assert.equal(r2.errors.length, 1);
  const llamadas = () => scalar<number>(`SELECT count(*)::int AS v FROM outbound_llm_call WHERE workspace_id = $1 AND purpose = 'classify'`, [w.id]);
  assert.equal(await llamadas(), 1, 'una sola llamada pagada');
  assert.equal(await scalar<number>(`SELECT intent_attempts AS v FROM outbound_message WHERE id = $1`, [m]), 2);
  // La tercera, con los efectos de verdad: aplica la decisión guardada sin volver a llamar.
  const r3 = await correr();
  assert.deepEqual(r3.classified.map((c) => c.intent), ['interested']);
  assert.equal(await llamadas(), 1);
  assert.equal(await scalar<boolean>(`SELECT intent_decision IS NULL AS v FROM outbound_message WHERE id = $1`, [m]), true);

  // Otro que falla siempre: al tercer fallo queda ambiguo, con un aviso, y sale de la cola.
  const w2 = await workspace(23, { contacts: 1 });
  const m2 = await entrante(w2, 'Me interesa.', 1);
  let rendido: string[] = [];
  for (let i = 0; i < INTENT_MAX_ATTEMPTS; i++) {
    rendido = (await runIntent(motor, { classifier: modelo, now: () => new Date(), workspaceId: w2.id, apply: rompe })).gaveUp;
  }
  assert.deepEqual(rendido, [m2]);
  const fila = (await db.raw.query<{ intent: string; conf: string; source: string }>(
    `SELECT intent, intent_confidence::text AS conf, intent_source AS source FROM outbound_message WHERE id = $1`, [m2],
  )).rows[0]!;
  assert.deepEqual([fila.intent, fila.conf, fila.source], ['ambiguous', '0.000', 'model']);
  assert.equal(await scalar<string>(`SELECT severity AS v FROM notification WHERE entity_id = $1 AND entity_type = 'outbound_message_intent'`, [m2]), 'warning');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_llm_call WHERE workspace_id = $1`, [w2.id]), 1);
  const otra = await runIntent(motor, { classifier: modelo, now: () => new Date(), workspaceId: w2.id, apply: rompe });
  assert.equal(otra.errors.length, 0, 'ya no está en la cola');
});

test('el clasificador recibe lo que dijeron las cabeceras', async () => {
  const w = await workspace(24, { contacts: 1 });
  await conversacion(w, 'Gracias por tu correo. Estoy de vacaciones hasta el 2026-10-02.', { automatic: true });
  const vistos: boolean[] = [];
  const espia: IntentClassifier = {
    source: 'fake', model: 'espia',
    async classify(input: IntentInput) {
      vistos.push(input.automatic);
      return fakeClassifier.classify(input);
    },
  };
  await runIntent(motor, { classifier: espia, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.deepEqual(vistos, [true]);
});

test('una persona corrige la intención desde la bandeja: la ambigua pasa a interesada y el negocio se mueve', async () => {
  const w = await workspace(25, { contacts: 1 });
  const deal = await negocio(w);
  const { contact } = await conversacion(w, F.ambigua!.body, { deal });
  const dudoso = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.5,"return_date":null,"referral":null,"reason":"Solo dice ok."}'));
  await runIntent(motor, { classifier: dudoso, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  const m = conv.messages.find((x) => x.direction === 'inbound')!;
  assert.deepEqual([m.intent, m.intentReason], ['ambiguous', 'Solo dice ok.']);
  const r = await comoLaWeb(w.id, (tx) => reclassifyInboxMessage(tx, { messageId: m.id, intent: 'interested', now: bogota('2026-09-23', '16:00') }));
  assert.equal(r.ok && r.dealMoved, true);
  assert.equal(await scalar<string>('SELECT stage_id AS v FROM deal WHERE id = $1', [deal]), 'conversacion');
  assert.equal(await scalar<string>(`SELECT intent_source AS v FROM outbound_message WHERE id = $1`, [m.id]), 'person');
  assert.equal(await scalar<boolean>(`SELECT read_at IS NOT NULL AS v FROM notification WHERE entity_id = $1 AND entity_type = 'outbound_message_intent'`, [m.id]), true, 'el aviso de revisarla queda leído');
});

test('una ambigua corregida a baja deja la ficha de baja y cancela lo pendiente; una baja ya no se corrige', async () => {
  const w = await workspace(28, { contacts: 1 });
  const pitch = await pitchPendiente(w, w.contacts[0]!);
  const { contact } = await conversacion(w, F.ambigua!.body);
  const dudoso = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.5,"return_date":null,"referral":null,"reason":"Solo dice ok."}'));
  await runIntent(motor, { classifier: dudoso, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  const m = await scalar<string>(`SELECT id AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [contact]);
  const r = await comoLaWeb(w.id, (tx) => reclassifyInboxMessage(tx, { messageId: m, intent: 'unsubscribe', now: bogota('2026-09-23', '16:00') }));
  assert.equal(r.ok && r.optOut, true);
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [contact]), true);
  assert.equal(await scalar<string>("SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE id = $1", [pitch]), 'canceled:replied', 'lo detuvo la respuesta');
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), 'opted_out');
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) => reclassifyInboxMessage(tx, { messageId: m, intent: 'interested', now: bogota('2026-09-23', '16:05') })),
    { ok: false, code: 'opted_out' },
  );
});

test('corregir un «fuera de la oficina» que no lo era: la cadencia no vuelve sola', async () => {
  const w = await workspace(26, { contacts: 1 });
  const { contact } = await conversacion(w, F.fuera_de_oficina!.body);
  await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), 'paused');
  const m = await scalar<string>(`SELECT id AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [contact]);
  const r = await comoLaWeb(w.id, (tx) => reclassifyInboxMessage(tx, { messageId: m, intent: 'not_now', now: bogota('2026-09-23', '16:00') }));
  assert.equal(r.ok, true);
  const e = await scalar<string>(`SELECT status || ':' || to_char(resume_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS v FROM outbound_enrollment WHERE contact_id = $1`, [contact]);
  assert.equal(e, 'cooldown:2026-12-22', 'noventa días desde la respuesta');
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE contact_id = $1 AND status IN ('scheduled', 'held', 'draft')`, [contact]), 0,
    'lo que el «fuera de la oficina» había devuelto a la cola, cancelado',
  );
});

test('«me interesa» de una marca sin negocio abierto (cadencia en frío) abre uno en «En conversación» con «Responder hoy»', async () => {
  const w = await workspace(29, { contacts: 1 });
  const { contact } = await conversacion(w, F.me_interesa!.body);
  assert.equal(await scalar<number>('SELECT count(*)::int AS v FROM deal WHERE company_id = $1', [w.company]), 0, 'sin negocio');
  const rep = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.deepEqual(rep.classified.map((c) => [c.intent, c.dealMoved]), [['interested', true]]);
  const d = (await db.raw.query<{
    id: string; stage_id: string; next_action: string; due: string; owner: string | null; currency: string; history: number; name: string;
  }>(
    `SELECT id, stage_id, next_action, to_char(next_action_due AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS due,
            owner_user_id AS owner, currency, name,
            (SELECT count(*)::int FROM deal_stage_history h WHERE h.deal_id = deal.id AND h.to_stage_id = 'conversacion') AS history
       FROM deal WHERE company_id = $1`, [w.company],
  )).rows;
  assert.equal(d.length, 1, 'un negocio, uno solo');
  assert.deepEqual([d[0]!.stage_id, d[0]!.next_action, d[0]!.due, d[0]!.history], ['conversacion', 'Responder hoy', '2026-09-23 23:59', 1]);
  assert.equal(d[0]!.name, 'Conversación con Marca 29');
  assert.equal(d[0]!.currency.trim(), 'COP', 'en la moneda del espacio');
  assert.equal(
    await scalar<string | null>('SELECT enrolled_by AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), d[0]!.owner,
    'el dueño es quien enroló',
  );
  assert.equal(await scalar<string>('SELECT deal_id AS v FROM outbound_enrollment WHERE contact_id = $1', [contact]), d[0]!.id, 'la cadencia queda enlazada');
  assert.equal(
    await scalar<string>(`SELECT body_es AS v FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_message_intent'`, [w.id]),
    'Abrimos un negocio con Marca 29 en «En conversación» y la siguiente acción es responder hoy. Tienes la conversación en la bandeja.',
  );
  // La bandeja lo enseña con el negocio.
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  assert.equal(conv.deal?.stageId, 'conversacion');
  assert.equal(conv.deal?.nextAction, 'Responder hoy');
});

test('«ahora no» sin cadencia que enfriar no promete que se enfría: dice cuándo volver a escribir', async () => {
  const w = await workspace(30, { contacts: 1 });
  const pitch = await pitchPendiente(w, w.contacts[0]!);
  await entrante(w, F.ahora_no!.body, 1);
  const r = await runIntent(motor, { classifier: fakeClassifier, now: () => new Date(), workspaceId: w.id });
  assert.deepEqual(r.classified.map((c) => c.intent), ['not_now']);
  assert.equal(
    await scalar<string>("SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE id = $1", [pitch]), 'canceled:not_now',
    'el pitch suelto no sale en frío después de «ahora no»',
  );
  const aviso = await scalar<string>(
    `SELECT body_es AS v FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_message_intent'`, [w.id],
  );
  assert.match(aviso, /^Dice que ahora no\. Si quieres, escríbele de nuevo después del \d+ de \p{L}+ de \d{4}\.$/u);
  assert.doesNotMatch(aviso, /se enfría|bandeja de aprobación/);
});

test('una respuesta dudosa sin cadencia detiene el pitch suelto; uno programado después de leerla, no', async () => {
  const w = await workspace(37, { contacts: 1 });
  const antes = await pitchPendiente(w, w.contacts[0]!);
  await entrante(w, F.ambigua!.body, 1);
  const despues = await scalar<string>(
    `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for)
     VALUES ($1, $2, $3, 'email', 'Lo hablamos', 'Te escribo de nuevo.', 'scheduled', now() + interval '3 days') RETURNING id AS v`,
    [w.id, w.company, w.contacts[0]],
  );
  const dudoso = new LlmIntentClassifier(scriptedModel('{"intent":"interested","confidence":0.5,"return_date":null,"referral":null,"reason":"Solo dice ok."}'));
  const r = await runIntent(motor, { classifier: dudoso, now: () => new Date(), workspaceId: w.id });
  assert.deepEqual(r.classified.map((c) => c.intent), ['ambiguous']);
  assert.equal(await scalar<string>("SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE id = $1", [antes]), 'canceled:replied');
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_touch WHERE id = $1', [despues]), 'scheduled', 'la decisión de la persona se respeta');
});

test('el retenido del seed 0008 con una cifra sin origen no se aprueba tal cual, ni tocando una coma; con una cifra del perfil, sí', async () => {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  const demo = await createEmbeddedDb({ snapshot: true });
  try {
    const WS = '00000002-0000-4000-8000-000000000001';
    const TOQUE = '00000008-0000-4000-8000-000000070002';
    const aprobar = (body?: string) =>
      demo.withWorkspace(WS, (tx) => approveQueuedTouch(tx, { touchId: TOQUE, ...(body ? { body } : {}), userId: null, now: new Date() }));
    const cola = await demo.withWorkspace(WS, (tx) => listApprovalQueue(tx));
    const item = cola.items.find((x) => x.touchId === TOQUE)!;
    assert.equal(item.heldReason, 'quality_risk:unsourced_figure');
    assert.equal(item.contactSource, 'public_website', 'con la procedencia del contacto a la vista');
    assert.deepEqual(await aprobar(), { ok: false, code: 'unsourced_figure', detail: '23 %' });
    // Tocar una coma no respalda la cifra que la IA dejó sin origen.
    assert.deepEqual(await aprobar(item.body.replace('entre semana y', 'entre semana, y')), { ok: false, code: 'unsourced_figure', detail: '23 %' });
    // Con una cifra del perfil (el 37 % de su audiencia de TikTok tiene de 25 a 34 años), sale y queda citada.
    const conCifra = item.body.replace(
      'El 23 % de mis videos de desayuno terminan en una compra.', 'El 37 % de quienes me siguen en TikTok tiene entre 25 y 34 años.',
    );
    assert.equal((await aprobar(conCifra)).ok, true);
    const claims = (await demo.queryAsSuperuser<{ claims: Array<{ id: string }> }>(`SELECT claims FROM outbound_touch WHERE id = $1`, [TOQUE])).rows[0]!;
    assert.deepEqual(claims.claims.map((c) => c.id), ['audience:tiktok:age:25-34']);
  } finally {
    await demo.close();
  }
});

test('el seguimiento en el hilo retenido del seed (Vitalé, 7,4 de 10) se regenera y vuelve a la cola sin asunto propio', async () => {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  const demo = await createEmbeddedDb({ snapshot: true });
  try {
    const WS = '00000002-0000-4000-8000-000000000001';
    const VITALE = '00000005-0000-4000-8000-000000070004';
    const enCola = async () => (await demo.withWorkspace(WS, (tx) => listApprovalQueue(tx))).items.find((x) => x.touchId === VITALE)!;
    const antes = await enCola();
    assert.deepEqual([antes.stepType, antes.heldReason, antes.regenerable], ['email_reply', 'quality_low:7.4', true]);
    assert.deepEqual(
      await demo.withWorkspace(WS, (tx) => regenerateQueuedTouch(tx, { touchId: VITALE, hint: 'other_angle', instructions: null, userId: null })),
      { ok: true },
    );
    const writers = { mode: 'fake' as const, generator: createFakeGenerator(), judge: createFakeJudge() };
    const m = motorDbFromClient(demo);
    const g = await runGenerate(m, { writers, now: () => new Date(), workspaceId: WS });
    assert.ok(g.generated.includes(VITALE), JSON.stringify(g));
    await runReview(m, { writers, now: () => new Date(), workspaceId: WS });
    const despues = await enCola();
    assert.equal(despues.stepType, 'email_reply', 'sigue siendo una respuesta en el hilo');
    assert.equal(despues.subject, null, 'sin asunto propio: sale como «Re:» del hilo');
    assert.ok(despues.body.trim().length > 0 && despues.body !== antes.body, 'con la versión nueva');
  } finally {
    await demo.close();
  }
});

test('una respuesta de la bandeja cancelada no sale', async () => {
  const w = await workspace(27, { contacts: 1 });
  const { contact, fake } = await conversacion(w, F.me_interesa!.body);
  const touchId = randomUUID();
  const r = await comoLaWeb(w.id, (tx) =>
    replyInInboxThread(tx, { touchId, contactId: contact, channel: 'email', body: 'Con una errata', userId: null, now: bogota('2026-09-23', '15:12') }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(await comoLaWeb(w.id, (tx) => cancelInboxReply(tx, touchId)), { ok: true, body: 'Con una errata' });
  const sale = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:14')));
  assert.deepEqual(sale.sent, [], 'la cancelada no sale');
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  assert.deepEqual(conv.notSent.map((p) => [p.touchId, p.blockedReason]), [[touchId, 'canceled_by_person']]);
});

test('una baja que pide un tercero en copia no da de baja a la ficha: la bandeja deja decidir, y «baja» desde ahí sí la da', async () => {
  const w = await workspace(31, { contacts: 1 });
  const { contact } = await conversacion(w, F.baja_explicita!.body, { from: 'Otra Persona <otra@marca.test>' });
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [contact]), false, 'la ficha no queda de baja');
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  const m = conv.messages.find((x) => x.direction === 'inbound')!;
  assert.deepEqual([m.intent, m.fromContact, conv.contactOptedOut, conv.replyBlock], ['unsubscribe', false, false, null]);
  assert.equal(conv.messages[0]!.fromContact, true, 'lo nuestro no es de un tercero');
  // Se corrige: una persona decide que la baja vale para la ficha.
  const r = await comoLaWeb(w.id, (tx) => reclassifyInboxMessage(tx, { messageId: m.id, intent: 'unsubscribe', now: bogota('2026-09-23', '16:00') }));
  assert.equal(r.ok && r.optOut, true);
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [contact]), true, 'ahora sí, de baja');
  // Y ya de baja, no se corrige más.
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) => reclassifyInboxMessage(tx, { messageId: m.id, intent: 'interested', now: bogota('2026-09-23', '16:05') })),
    { ok: false, code: 'opted_out' },
  );

  // La otra salida: no era una baja de la ficha, y se corrige a otra intención.
  const w2 = await workspace(32, { contacts: 1 });
  const { contact: c2 } = await conversacion(w2, F.baja_explicita!.body, { from: 'otra@marca.test' });
  const m2 = await scalar<string>(`SELECT id AS v FROM outbound_message WHERE contact_id = $1 AND direction = 'inbound'`, [c2]);
  const r2 = await comoLaWeb(w2.id, (tx) => reclassifyInboxMessage(tx, { messageId: m2, intent: 'not_now', now: bogota('2026-09-23', '16:00') }));
  assert.equal(r2.ok, true);
  assert.equal(await scalar<string>('SELECT intent AS v FROM outbound_message WHERE id = $1', [m2]), 'not_now');
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [c2]), false);
});

test('una respuesta cancela lo que quedaba programado para la ficha fuera de la cadencia; la respuesta de la bandeja, no', async () => {
  const w = await workspace(33, { contacts: 1 });
  const pitch = await pitchPendiente(w, w.contacts[0]!);
  const { contact } = await conversacion(w, F.me_interesa!.body);
  assert.equal(
    await scalar<string>("SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE id = $1", [pitch]), 'canceled:replied',
    'la respuesta lo detiene antes de clasificarla',
  );
  // Una respuesta escrita en la bandeja antes de que se clasifique: esa sí sale.
  const touchId = randomUUID();
  await comoLaWeb(w.id, (tx) =>
    replyInInboxThread(tx, { touchId, contactId: contact, channel: 'email', body: '¡Hablemos el jueves!', userId: null, now: bogota('2026-09-23', '15:05') }),
  );
  const rep = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.deepEqual(rep.classified.map((c) => c.intent), ['interested']);
  assert.equal(
    await scalar<string>("SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE id = $1", [pitch]), 'canceled:replied',
    'el pitch en frío no sale encima de la conversación',
  );
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_touch WHERE id = $1', [touchId]), 'scheduled');
});

test('el falso no lee «no me interesa» como interés: ahora no, sin abrir negocio', async () => {
  const w = await workspace(34, { contacts: 1 });
  assert.equal(F.rechazo!.intent, 'not_now');
  await conversacion(w, F.rechazo!.body);
  const rep = await runIntent(motor, { classifier: fakeClassifier, now: () => bogota('2026-09-23', '15:06'), workspaceId: w.id });
  assert.deepEqual(rep.classified.map((c) => [c.intent, c.dealMoved]), [['not_now', false]]);
  assert.equal(await scalar<number>('SELECT count(*)::int AS v FROM deal WHERE company_id = $1', [w.company]), 0, 'ningún negocio');
  for (const k of ['rechazo_plural', 'rechazo_en'] as const) {
    const r = await fakeClassifier.classify({
      body: F[k]!.body, subject: null, channel: 'email', previousOutbound: null, automatic: false, occurredAt: new Date(), timeZone: 'America/Bogota',
    });
    assert.equal(r.final, F[k]!.intent, k);
  }
});

test('una respuesta de la bandeja retenida va a la cola como respuesta en el hilo: sin asunto propio ni «Regenerar», y se aprueba tal cual', async () => {
  const w = await workspace(35, { contacts: 1 });
  const { contact, fake } = await conversacion(w, F.me_interesa!.body);
  // Sin dirección postal (un espacio nuevo, con el envío apagado), la bandeja no deja escribirla: lo dice antes de crear nada.
  await db.raw.query(`UPDATE outbound_policy SET enabled = false, postal_address = NULL WHERE workspace_id = $1`, [w.id]);
  const antes = randomUUID();
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) =>
      replyInInboxThread(tx, { touchId: antes, contactId: contact, channel: 'email', body: 'Hola', userId: null, now: bogota('2026-09-23', '15:10') }),
    ),
    { ok: false, code: 'no_postal_address' },
  );
  assert.equal(await scalar<number>('SELECT count(*)::int AS v FROM outbound_touch WHERE id = $1', [antes]), 0);
  const conv0 = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  assert.equal(conv0.postalAddressMissing, true);

  // Escrita con la dirección, y retenida por el despachador (aquí, a mano: un intento que no se pudo comprobar,
  // un hilo que se perdió): entra a la cola de aprobación.
  await db.raw.query(`UPDATE outbound_policy SET enabled = true, postal_address = 'Calle 93 # 11-26, Bogotá' WHERE workspace_id = $1`, [w.id]);
  const touchId = randomUUID();
  const r = await comoLaWeb(w.id, (tx) =>
    replyInInboxThread(tx, { touchId, contactId: contact, channel: 'email', body: 'El jueves me sirve.', userId: null, now: bogota('2026-09-23', '15:12') }),
  );
  assert.equal(r.ok, true);
  await db.raw.query(`UPDATE outbound_touch SET status = 'held', held_reason = 'reply_without_thread' WHERE id = $1`, [touchId]);

  const { items } = await comoLaWeb(w.id, (tx) => listApprovalQueue(tx));
  const item = items.find((x) => x.touchId === touchId)!;
  assert.deepEqual(
    [item.inboxReply, item.stepType, item.regenerable, item.threadSubject, item.subject],
    [true, 'email_reply', false, 'Hola, Persona', null],
    'en el hilo, sin asunto y sin pedirle a la IA un pitch en frío',
  );
  const conv = (await comoLaWeb(w.id, (tx) => loadInboxConversation(tx, contact, 'email')))!;
  assert.deepEqual(conv.pending.map((p) => [p.status, p.heldReason]), [['held', 'reply_without_thread']]);

  // Se aprueba tal cual: sin inventarle un asunto.
  const ok = await comoLaWeb(w.id, (tx) => approveQueuedTouch(tx, { touchId, userId: null, now: bogota('2026-09-23', '15:20') }));
  assert.equal(ok.ok, true);
  const sale = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:22')));
  assert.deepEqual(sale.sent, [touchId]);
  assert.equal(fake.email.sent.at(-1)!.subject, 'Re: Hola, Persona', 'en el hilo');
});
