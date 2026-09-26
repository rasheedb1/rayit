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
import { createFakeIntentClassifier, LlmIntentClassifier } from '@mc/core/outreach/intent';
import { llmCostUsd, type LlmClient } from '@mc/core/outreach/llm';
import {
  approveQueuedTouch, createReferralContact, listApprovalQueue, listInboxThreads, loadInboxConversation, markInboxThreadRead,
  replyInInboxThread, skipQueuedTouch,
} from '@mc/db/queries/bandejas';
import { enrollContacts } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runIntent } from '../src/jobs/ventas/outbound.intent.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
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
      return { text: answer, model: req.model, inputTokens: 640, outputTokens: 38, costUsd: llmCostUsd(req.model, 640, 38), stopReason: 'end_turn' };
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
  w: Ws, body: string, opts: { deal?: string; at?: Date; automatic?: boolean } = {},
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
  fake.email.reply(thread, body, at, undefined, { automatic: opts.automatic === true });
  await runReplies(motor, { readers: fake, now: () => new Date(at.getTime() + 5 * 60_000), workspaceId: w.id });
  return { contact, thread, fake };
}

test('terminado cuando: un retenido se aprueba desde la bandeja, queda programado y sale; editar y saltar', async () => {
  const w = await workspace(1, { contacts: 1, humanReview: true });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const [primero, segundo, tercero] = await touches(c);
  assert.deepEqual([primero!.status, primero!.held_reason], ['held', 'needs_review'], 'la revisión humana retiene');

  const cola = await comoLaWeb(w.id, (tx) => listApprovalQueue(tx));
  assert.deepEqual(cola.map((x) => x.touchId), [primero!.id, segundo!.id, tercero!.id]);
  const item = cola[0]!;
  assert.equal(item.companyName, 'Marca 1');
  assert.equal(item.contactName, 'Persona 1 Prueba');
  assert.deepEqual([item.stepIndex, item.stepCount, item.channel], [1, 3, 'email']);
  assert.equal(item.subject, 'Hola, Persona');
  assert.equal(item.heldReason, 'needs_review');
  assert.equal(item.regenerable, true, 'un correo se puede regenerar');
  assert.equal(cola[1]!.regenerable, false, 'una respuesta en el hilo no: la redacta el paso');
  // Lo ajeno (otro espacio no ve ni aprueba) se prueba con la RLS de verdad en packages/db/test/bandejas.test.ts.

  // Aprobar tal cual: queda programado, con quién y cuándo.
  const ahora = bogota('2026-09-23', '08:00');
  assert.deepEqual(await comoLaWeb(w.id, (tx) => approveQueuedTouch(tx, { touchId: primero!.id, userId: null, now: ahora })), { ok: true });
  // Editar y aprobar: sale lo que dejó la persona; lo que rompe una regla no se aprueba.
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) => approveQueuedTouch(tx, { touchId: segundo!.id, body: 'Hola, {{first_name}}', userId: null, now: ahora })),
    { ok: false, code: 'placeholders', detail: '{{first_name}}' },
  );
  assert.deepEqual(
    await comoLaWeb(w.id, (tx) =>
      approveQueuedTouch(tx, { touchId: segundo!.id, subject: null, body: 'Te dejo una idea concreta para la temporada.', userId: null, now: ahora }),
    ),
    { ok: true },
  );
  // Saltar: el tercero no sale y no frena a nadie.
  assert.deepEqual(await comoLaWeb(w.id, (tx) => skipQueuedTouch(tx, tercero!.id, ahora)), { ok: true });
  assert.deepEqual(await comoLaWeb(w.id, (tx) => skipQueuedTouch(tx, tercero!.id, ahora)), { ok: false, code: 'not_skippable' });

  const despues = await touches(c);
  assert.deepEqual(despues.map((x) => x.status), ['scheduled', 'scheduled', 'skipped']);
  assert.equal(await scalar<boolean>('SELECT approved_at IS NOT NULL AS v FROM outbound_touch WHERE id = $1', [primero!.id]), true);
  assert.deepEqual(await comoLaWeb(w.id, (tx) => listApprovalQueue(tx)), [], 'la cola queda vacía');

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
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: false });
  assert.deepEqual(await responder(), { ok: true, touchId, duplicate: true });
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

/** Un pitch programado a la misma ficha fuera de la cadencia: lo pendiente que solo una baja cancela. */
async function pitchPendiente(w: Ws, contact: string): Promise<string> {
  return scalar<string>(
    `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for)
     VALUES ($1, $2, $3, 'email', 'Otra idea', 'Te escribo con otra idea.', 'scheduled', now() + interval '3 days') RETURNING id AS v`,
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
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_touch WHERE id = $1', [pitchB]), 'scheduled', 'una respuesta sola no lo cancela');
  const baja = new LlmIntentClassifier(scriptedModel('{"intent":"unsubscribe","confidence":0.93,"return_date":null,"referral":null,"reason":"No quiere más propuestas."}'));
  const r2 = await runIntent(motor, { classifier: baja, now: () => bogota('2026-09-23', '15:06'), workspaceId: b.id });
  assert.deepEqual(r2.classified.map((c) => c.intent), ['unsubscribe']);
  assert.equal(await scalar<boolean>('SELECT opted_out AS v FROM contact WHERE id = $1', [cb]), true, 'la ficha queda de baja');
  assert.equal(await scalar<string>('SELECT opted_out_code AS v FROM contact WHERE id = $1', [cb]), 'reply_optout:email');
  assert.equal(await scalar<string>('SELECT status || \':\' || blocked_reason AS v FROM outbound_touch WHERE id = $1', [pitchB]), 'canceled:opted_out');
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE contact_id = $1 AND status IN ('draft', 'scheduled', 'held')`, [cb]), 0,
    'nada pendiente',
  );
  assert.equal(await scalar<string>('SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1', [cb]), 'opted_out');
  const llamada = (await db.raw.query<{ purpose: string; model: string; input_tokens: number; cost: string; tied: boolean }>(
    `SELECT purpose, model, input_tokens, cost::text AS cost, message_id IS NOT NULL AS tied FROM outbound_llm_call WHERE workspace_id = $1`, [b.id],
  )).rows;
  assert.deepEqual(llamada.map((l) => [l.purpose, l.model, l.input_tokens, l.tied]), [['classify', 'claude-haiku-4-5-20251001', 640, true]]);
  assert.equal(Number(llamada[0]!.cost), llmCostUsd('claude-haiku-4-5-20251001', 640, 38), 'con su costo');
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
  assert.deepEqual(cola.map((x) => x.heldReason), ['cooldown_over', 'cooldown_over']);
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
