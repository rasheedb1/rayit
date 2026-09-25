/**
 * VEN-10 · lo reclamado que no salió y el intento cuyo resultado no se
 * supo: vuelve a la cola, se comprueba con el proveedor antes de
 * reenviar, o lo resuelve una persona («sí salió» / «no salió»). Postgres
 * embebido con las migraciones del repo, como mc_worker, con el canal
 * falso y un reloj falso. Sin red.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeUnipile } from '@mc/connectors';
import { holdReasonText } from '@mc/core/outreach/messages';
import { enrollContacts, resolveUnconfirmedTouch, type UnconfirmedOutcome } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import type { ChannelSender } from '../src/jobs/ventas/canales/types.ts';
import { UnipileChannel } from '../src/jobs/ventas/canales/unipile.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, hex, motorKit, type Ws } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, comoLaWeb } = motorKit({ db: () => db, motor: () => motor, prefix: '00000114', slug: 'motor-ambiguo' });

test('lo reclamado que no se llegó a intentar vuelve a la cola, sin su enlace y con su plaza', async () => {
  const w = await workspace(1, { contacts: 3 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const ac = new AbortController();
  // El proveedor responde al primero y entonces la corrida se corta (timeout o apagado).
  const cortaDespuesDelPrimero: ChannelSender = {
    channel: 'email',
    configured: () => true,
    send: async (m) => {
      const r = await fake.email.send(m);
      ac.abort(new Error('timeout del job'));
      return r;
    },
  };
  const r = await runDispatch(motor, deps(w, { email: cortaDespuesDelPrimero }, () => bogota('2026-09-23', '12:00'), { signal: ac.signal }));
  assert.equal(r.claim.claimed, 3);
  assert.equal(r.sent.length, 1);
  assert.equal(r.released.length, 2);
  const devueltos = await db.raw.query<{ status: string; attempt_count: number; claimed_at: Date | null; links: number }>(
    `SELECT t.status, t.attempt_count, t.claimed_at, (SELECT count(*)::int FROM outbound_optout_link l WHERE l.touch_id = t.id) AS links
       FROM outbound_touch t WHERE t.id = ANY($1::uuid[])`, [r.released],
  );
  for (const d of devueltos.rows) assert.deepEqual({ ...d }, { status: 'scheduled', attempt_count: 0, claimed_at: null, links: 0 });
  const plazas = await db.raw.query<{ channel_account_id: string | null; period: string; count: number }>(
    `SELECT channel_account_id, period, count FROM outbound_counter WHERE workspace_id = $1 ORDER BY channel_account_id NULLS LAST, period`, [w.id],
  );
  assert.deepEqual(plazas.rows.map((p) => p.count), [1, 1, 1], 'día y semana de la cuenta y día del workspace: solo el que salió');
  // Nada queda en processing para que la siguiente corrida lo tome por zombi; salen después, sin avisos.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:10')));
  assert.equal(r2.zombies.failed + r2.zombies.released, 0);
  assert.deepEqual([...r2.sent].sort(), [...r.released].sort());
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id]), 0);
});

test('un intento ambiguo que el proveedor sí envió no se reenvía: se confirma', async () => {
  const w = await workspace(2, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  // Sale, pero la respuesta se corta (el timeout después del POST).
  fake.email.deliverThenFail(1);
  let clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.retried.length, 1);
  const tocado = r.retried[0]!;
  let [t] = await touches(c);
  assert.equal(t!.unconfirmed_attempt, 1, 'queda anotado el intento sin confirmar');
  assert.equal(fake.email.sent.length, 1, 'el proveedor sí lo envió');
  const plaza = await scalar<number>(`SELECT count::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'day' AND channel_account_id IS NOT NULL`, [w.id]);
  assert.equal(plaza, 1, 'la plaza de un envío que pudo salir no se devuelve');

  clock = new Date(t!.next_retry_at!.getTime() + 1000);
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.deepEqual(r2.confirmed, [tocado]);
  assert.equal(fake.email.sent.length, 1, 'no se reenvió');
  [t] = await touches(c);
  assert.deepEqual([t!.status, t!.provider_message_id, t!.unconfirmed_attempt], ['sent', fake.email.sent[0]!.providerMessageId, null]);
  const links = await db.raw.query<{ attempt: number; sent: boolean }>(
    `SELECT attempt, sent_at IS NOT NULL AS sent FROM outbound_optout_link WHERE touch_id = $1 ORDER BY attempt`, [tocado],
  );
  assert.deepEqual(links.rows.map((l) => [l.attempt, l.sent]), [[1, true], [2, false]], 'el enlace que salió es el del intento 1');
  const plazaDespues = await scalar<number>(`SELECT count::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'day' AND channel_account_id IS NOT NULL`, [w.id]);
  assert.equal(plazaDespues, 1, 'el segundo reclamo devolvió su plaza: un solo envío, una sola plaza');
});

test('un intento ambiguo que NO salió devuelve su plaza al reenviar: una sola plaza gastada, no dos (r5)', async () => {
  const w = await workspace(3, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  // El corte llega antes de que el proveedor lo envíe: ambiguo, pero no salió.
  fake.email.failNext(1, { kind: 'transient', code: 'network_ambiguous', message: 'timeout', ambiguous: true });
  let clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.retried.length, 1);
  let [t] = await touches(c);
  assert.equal(t!.unconfirmed_attempt, 1);
  const plazaDelDia = () =>
    scalar<number>(`SELECT count::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'day' AND channel_account_id IS NOT NULL`, [w.id]);
  assert.equal(await plazaDelDia(), 1, 'la plaza del intento ambiguo se conserva: pudo salir');
  assert.ok(await scalar<string>(`SELECT unconfirmed_caps_on::text AS v FROM outbound_touch WHERE id = $1`, [t!.id]), 'con el día de su plaza');

  clock = new Date(t!.next_retry_at!.getTime() + 1000);
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r2.sent.length, 1, 'el proveedor dijo que no salió: se envía');
  assert.equal(fake.email.sent.length, 1);
  [t] = await touches(c);
  assert.equal(t!.status, 'sent');
  assert.equal(await plazaDelDia(), 1, 'un solo envío, una sola plaza: la del ambiguo volvió');
  assert.equal(await scalar<string | null>(`SELECT unconfirmed_caps_on::text AS v FROM outbound_touch WHERE id = $1`, [t!.id]), null);
  const semana = await scalar<number>(
    `SELECT count::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'week' AND channel_account_id IS NOT NULL`, [w.id],
  );
  assert.equal(semana, 1, 'y la de la semana, igual');
});

test('un intento ambiguo que el canal no sabe comprobar se retiene para una persona', async () => {
  const w = await workspace(4, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.deliverThenFail(1);
  fake.email.unverifiable = true;
  let clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.retried.length, 1);
  let [t] = await touches(c);
  clock = new Date(t!.next_retry_at!.getTime() + 1000);
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r2.held.length, 1);
  [t] = await touches(c);
  assert.equal(t!.status, 'held');
  assert.equal(t!.held_reason, 'unconfirmed_attempt:1');
  assert.match(holdReasonText('es', t!.held_reason!), /no pudimos comprobar si el intento 1 salió/);
  assert.match(holdReasonText('en', t!.held_reason!), /couldn't confirm whether attempt 1 went out/);
  assert.equal(fake.email.sent.length, 1, 'ni un envío de más');
});

/** Un correo cuyo primer intento quedó sin confirmar y retenido (el canal no sabe comprobarlo). */
async function retenidoSinConfirmar(n: number): Promise<{ w: Ws; contact: string; touch: string; fake: ReturnType<typeof fakeChannels> }> {
  const w = await workspace(n, { contacts: 1 });
  const [contact] = w.contacts as [string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.deliverThenFail(1);
  fake.email.unverifiable = true;
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.retried.length, 1);
  const [t] = await touches(contact);
  const r2 = await runDispatch(motor, deps(w, fake, () => new Date(t!.next_retry_at!.getTime() + 1000)));
  assert.equal(r2.held.length, 1);
  const [held] = await touches(contact);
  assert.deepEqual([held!.status, held!.held_reason], ['held', 'unconfirmed_attempt:1']);
  return { w, contact, touch: held!.id, fake };
}

const resolver = (w: Ws, touch: string, outcome: UnconfirmedOutcome) =>
  comoLaWeb(w.id, (tx) => resolveUnconfirmedTouch(tx, touch, outcome, bogota('2026-09-23', '15:00')));

const plazas = (w: Ws) =>
  scalar<number>(
    `SELECT coalesce(sum(count), 0)::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'day' AND channel_account_id IS NOT NULL`,
    [w.id],
  );

test('«sí salió»: queda enviado sin reenviar, su enlace de baja cuenta, y la respuesta del paso siguiente espera a encontrar su hilo', async () => {
  const { w, contact, touch, fake } = await retenidoSinConfirmar(5);
  const antes = await plazas(w);
  assert.deepEqual(await resolver(w, touch, 'was_sent'), { ok: true });
  const fila = (await db.raw.query<{ status: string; blocked_reason: string | null; ua: number | null; sent: boolean }>(
    `SELECT status, blocked_reason, unconfirmed_attempt AS ua, sent_at IS NOT NULL AS sent FROM outbound_touch WHERE id = $1`, [touch],
  )).rows[0]!;
  assert.deepEqual({ ...fila }, { status: 'sent', blocked_reason: 'sent_confirmed_by_user', ua: null, sent: true });
  const enlace = await scalar<boolean>(`SELECT sent_at IS NOT NULL AS v FROM outbound_optout_link WHERE touch_id = $1 AND attempt = 1`, [touch]);
  assert.equal(enlace, true, 'la baja de un clic del correo que salió sigue funcionando');
  assert.equal(await plazas(w), antes, 'la plaza del intento se queda gastada: salió');
  assert.deepEqual(await resolver(w, touch, 'resend'), { ok: false, code: 'not_unconfirmed' }, 'dos veces no');

  // El paso de detrás es la respuesta en el hilo, y el hilo del correo que
  // confirmó la persona no se conoce: no sale como un «Re:» huérfano.
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(r.sent.length, 0);
  assert.deepEqual(r.held.map((h) => h.reason), ['reply_without_thread']);
  assert.equal(fake.email.sent.length, 1, 'solo el intento 1, que salió');

  // El lector de respuestas le pregunta a Gmail por ese correo, anota su hilo y devuelve la respuesta a la cola.
  fake.email.unverifiable = false;
  const lector = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-24', '15:05'), workspaceId: w.id });
  assert.deepEqual([lector.threadsRecovered, lector.released], [1, 1]);
  const hilo = fake.email.sent[0]!.threadRef;
  assert.equal(await scalar<string>(`SELECT thread_ref AS v FROM outbound_touch WHERE id = $1`, [touch]), hilo);

  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:10')));
  assert.equal(r2.sent.length, 1);
  assert.equal(fake.email.sent.length, 2, 'el intento 1 y el paso 2: nada repetido');
  const [, respuesta] = fake.email.sent;
  assert.equal(respuesta!.threadRef, hilo, 'en el hilo del correo confirmado');
  assert.equal(respuesta!.reply?.messageIdRfc, fake.email.sent[0]!.messageIdRfc, 'con su In-Reply-To');
  assert.match(respuesta!.subject ?? '', /^Re: /);
  assert.deepEqual((await touches(contact)).map((t) => t.status), ['sent', 'sent', 'scheduled']);

  // Y si la marca responde a ese correo, la cadencia se detiene.
  fake.email.reply(hilo, 'Gracias, lo vemos la otra semana.', bogota('2026-09-24', '16:00'));
  await runReplies(motor, { readers: fake, now: () => bogota('2026-09-24', '16:05'), workspaceId: w.id });
  assert.deepEqual((await touches(contact)).map((t) => t.status), ['sent', 'sent', 'canceled']);
});

test('«no salió»: vuelve a la cola sin la marca, con su plaza devuelta, y sale una vez', async () => {
  const { w, contact, touch, fake } = await retenidoSinConfirmar(6);
  const antes = await plazas(w);
  assert.deepEqual(await resolver(w, touch, 'resend'), { ok: true });
  const [t] = await touches(contact);
  assert.deepEqual([t!.status, t!.held_reason, t!.unconfirmed_attempt], ['scheduled', null, null]);
  assert.equal(await plazas(w), antes - 1, 'la plaza del intento vuelve');
  const enlaces = await scalar<number>(`SELECT count(*)::int AS v FROM outbound_optout_link WHERE touch_id = $1 AND attempt = 1`, [touch]);
  assert.equal(enlaces, 0, 'el enlace de un intento que no salió se borra');
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '16:00')));
  assert.equal(r.sent.length, 1, 'sale sin volver a preguntar');
  assert.equal(r.held.length, 0);
  assert.equal((await touches(contact))[0]!.status, 'sent');
});

test('un chat nuevo de Unipile que no se puede comprobar: «no salió» lo envía de verdad, sin volver a retenerlo', async () => {
  const w = await workspace(7, { contacts: 1 });
  const [c] = w.contacts as [string];
  const acc = `${w.id.slice(0, 24)}0000000ac002`;
  await db.raw.exec(`
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
    VALUES ('${acc}', '${w.id}', 'linkedin', 'unipile', 'uni-linkedin-ambiguo-${w.n}', 'Creadora ${w.n}', 'connected', 25, 100);
    UPDATE contact SET linkedin_url = 'https://www.linkedin.com/in/persona-ambiguo' WHERE id = '${c}';
  `);
  const seq = `${w.id.slice(0, 24)}${hex(0x5e77, 12)}`;
  await db.raw.exec(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode) VALUES ('${seq}', '${w.id}', 'LinkedIn', 'linkedin', 'active', 'auto');
    INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, body_template,
                               generate_with_ai)
    VALUES ('${w.id}', '${seq}', 0, 0, 'linkedin_message', 'linkedin', '10:00', 'Hola, {{first_name}}: una idea para {{company}}.', false);
  `);
  await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  const api = new FakeUnipile();
  api.addAccount({ id: `uni-linkedin-ambiguo-${w.n}` });
  const linkedin = new UnipileChannel('linkedin', { api });
  // Un corte de red al abrir el chat: ambiguo, y en un chat nuevo Unipile no sabe decir si salió.
  api.failNext('sendMessage', 'transient', 'network');
  const r1 = await runDispatch(motor, deps(w, { linkedin }, () => bogota('2026-09-23', '12:00')));
  assert.equal(r1.retried.length, 1, 'ambiguo: a reintento');
  const id = await scalar<string>(`SELECT id AS v FROM outbound_touch WHERE contact_id = $1 AND channel = 'linkedin'`, [c]);
  const retry = await scalar<Date>(`SELECT next_retry_at AS v FROM outbound_touch WHERE id = $1`, [id]);
  const r2 = await runDispatch(motor, deps(w, { linkedin }, () => new Date(new Date(retry).getTime() + 1000)));
  assert.equal(r2.held.length, 1, 'retenido: no se sabe si salió');
  assert.equal(await scalar<string>(`SELECT held_reason AS v FROM outbound_touch WHERE id = $1`, [id]), 'unconfirmed_attempt:1');

  assert.deepEqual(await resolver(w, id, 'resend'), { ok: true });
  const r3 = await runDispatch(motor, deps(w, { linkedin }, () => bogota('2026-09-23', '16:00')));
  assert.equal(r3.sent.length, 1, 'salió; antes volvía a retenerse para siempre');
  assert.equal(r3.held.length, 0);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_touch WHERE id = $1`, [id]), 'sent');
});

test('resolver lo ajeno o lo que no es un intento sin confirmar no toca nada', async () => {
  const { w, touch } = await retenidoSinConfirmar(9);
  const otro = await workspace(8, { contacts: 1 });
  assert.deepEqual(await resolver(otro, touch, 'was_sent'), { ok: false, code: 'not_found' }, 'otro workspace no lo ve');
  await enroll(otro, bogota('2026-09-23', '07:00'));
  const [normal] = await touches(otro.contacts[0]!);
  assert.deepEqual(await resolver(otro, normal!.id, 'resend'), { ok: false, code: 'not_unconfirmed' });
  await db.raw.query(`UPDATE contact SET opted_out = true WHERE owner_workspace_id = $1`, [w.id]);
  assert.deepEqual(await resolver(w, touch, 'was_sent'), { ok: false, code: 'opted_out' });
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_touch WHERE id = $1`, [touch]), 'held');
});

test('si releer el toque falla antes de marcar el envío, no es un zombi que «pudo salir»: vuelve a la cola sin aviso y sale', async () => {
  const w = await workspace(10, { contacts: 1 });
  const [c] = w.contacts as [string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  // La primera relectura (loadSendContext bloquea el enrolamiento) falla: la base se cae a mitad de la corrida.
  let armada = true;
  const caida: MotorDb = {
    transaction: (fn) =>
      motor.transaction((tx) =>
        fn(Object.assign(Object.create(tx) as typeof tx, {
          query: (text: string, params?: unknown[]) => {
            if (armada && text.includes('FOR NO KEY UPDATE OF e')) {
              armada = false;
              throw new Error('se cortó la conexión con la base');
            }
            return tx.query(text, params);
          },
        })),
      ),
  };
  const r = await runDispatch(caida, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.errors.length, 1);
  assert.equal(fake.email.sent.length, 0, 'nada llegó al proveedor');
  const [t] = await touches(c);
  assert.equal(t!.status, 'processing');
  assert.equal(await scalar<boolean>(`SELECT send_started_at IS NULL AS v FROM outbound_touch WHERE id = $1`, [t!.id]), true, 'sin la marca de envío');

  // Cinco minutos después: los zombis lo devuelven a la cola, sin aviso, y sale una vez.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:07')));
  assert.deepEqual([r2.zombies.released, r2.zombies.failed], [1, 0]);
  assert.equal(r2.sent.length, 1);
  assert.equal(fake.email.sent.length, 1);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id]), 0);
});
