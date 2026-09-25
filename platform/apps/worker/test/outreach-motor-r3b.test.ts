/**
 * VEN-10 r3 (segunda vuelta) · lo que la revisión de la r2 rehecha
 * encontró en el motor, caso por caso, sobre Postgres embebido con las
 * migraciones del repo, como mc_worker (y con el workspace fijado donde
 * actúa una persona), con el canal falso o el de Unipile
 * sobre FakeUnipile y un reloj falso. Sin red.
 *
 *   · la cuenta que envía: dos Gmail con tope 1 envían dos correos el
 *     mismo día; la respuesta en el hilo sale por el buzón del hilo, y
 *     espera si ese buzón cae (hallazgo 6);
 *   · una ficha pública que pide la baja respondiendo: la ficha
 *     compartida no se marca, este workspace no la vuelve a enrolar y
 *     otro sí (hallazgos 3 y 16);
 *   · un intento sin confirmar: «sí salió» lo registra y la cadencia
 *     sigue; «no salió» lo vuelve a enviar con su plaza devuelta, también
 *     en Unipile, donde un chat nuevo no se puede comprobar (hallazgo 4);
 *   · una dirección mal escrita se salta sin tumbar el lote (r2 rehecha).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeUnipile } from '@mc/connectors';
import type { WorkspaceTx } from '@mc/db/client';
import { enrollContacts, resolveUnconfirmedTouch, type UnconfirmedOutcome } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
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

const { workspace, enroll, deps, touches, scalar } = motorKit({ db: () => db, motor: () => motor, prefix: '0000010e', slug: 'motor-r3b' });

/**
 * Lo que hace una persona desde la ficha, con el workspace fijado en la
 * transacción como withWorkspace. Aquí corre como el dueño de la base del
 * arnés del worker (que no le da privilegios a mc_app); el rol mc_app y la
 * RLS de verdad se prueban en packages/db/test/outreach-aprobar.test.ts.
 */
async function comoLaWeb<T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  return db.raw.transaction(async (raw) => {
    await raw.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    const tx = {
      workspaceId,
      db: null as never,
      query: async (text: string, params: readonly unknown[] = []) => {
        const r = await raw.query(text, params as unknown[]);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    } as unknown as WorkspaceTx;
    return fn(tx);
  });
}

/** Una segunda cuenta de Gmail conectada en el workspace. */
async function otroGmail(w: Ws, dailyCap: number): Promise<string> {
  const acc = `${w.id.slice(0, 24)}0000000ac0b2`;
  await db.raw.exec(`
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:r3b-otro-${w.n}', '${w.id}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap,
                                          weekly_cap, secret_ref, created_at)
    VALUES ('${acc}', '${w.id}', 'email', 'gmail_oauth', 'agencia${w.n}@motor-r3b.test', 'Agencia ${w.n}', 'connected', ${dailyCap}, 200,
            'enc:gmail:r3b-otro-${w.n}', now() + interval '1 minute');
  `);
  return acc;
}

/** La cuenta con la que salió cada toque de un contacto, en el orden de sus pasos. */
async function cuentas(contactId: string): Promise<Array<string | null>> {
  const { rows } = await db.raw.query<{ acc: string | null }>(
    `SELECT t.channel_account_id AS acc FROM outbound_touch t JOIN outbound_step s ON s.id = t.step_id
      WHERE t.contact_id = $1 ORDER BY s.day_offset, s.order_in_day`,
    [contactId],
  );
  return rows.map((r) => r.acc);
}

// ---------------------------------------------------------------------
// La cuenta que envía (hallazgo 6)
// ---------------------------------------------------------------------

test('dos Gmail con tope 1: salen los dos correos del día, uno por cuenta, y nada se va a mañana', async () => {
  const w = await workspace(1, { contacts: 2, dailyCap: 1 });
  const segunda = await otroGmail(w, 1);
  const [c1, c2] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 2, 'la segunda cuenta tenía plaza');
  assert.equal(r.claim.rescheduled.length, 0);
  const primeros = [(await cuentas(c1))[0], (await cuentas(c2))[0]];
  assert.deepEqual(new Set(primeros), new Set([w.gmail, segunda]), 'una por cuenta');

  // El día 1, la respuesta en el hilo de cada una sale por SU buzón.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(r2.sent.length, 2);
  for (const c of [c1, c2]) {
    const [primero, respuesta] = await cuentas(c);
    assert.equal(respuesta, primero, 'el mismo buzón que tiene el hilo');
  }
});

test('la respuesta en el hilo espera a SU buzón caído aunque otro esté conectado; la otra cadencia sigue', async () => {
  const w = await workspace(2, { contacts: 2, dailyCap: 1 });
  const segunda = await otroGmail(w, 5);
  const [c1, c2] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  const deLaPrimera = (await cuentas(c1))[0] === w.gmail ? c1 : c2;
  const deLaSegunda = deLaPrimera === c1 ? c2 : c1;
  assert.equal((await cuentas(deLaSegunda))[0], segunda);

  await db.raw.query(`UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = $1`, [w.gmail]);
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(r.sent.length, 1, 'solo la del buzón conectado');
  assert.deepEqual(r.claim.waitingAccount.map((x) => x.touchId), [(await touches(deLaPrimera))[1]!.id]);
  assert.equal((await touches(deLaPrimera))[1]!.status, 'scheduled', 'espera, no sale por otro buzón');
  assert.equal((await cuentas(deLaSegunda))[1], segunda);
});

// ---------------------------------------------------------------------
// Una ficha pública que pide la baja (hallazgos 3 y 16)
// ---------------------------------------------------------------------

test('una ficha pública que responde «no me escriban más»: no se marca la ficha compartida, A no la vuelve a enrolar y B sí', async () => {
  const a = await workspace(3, { contacts: 1 });
  const b = await workspace(4, { contacts: 1 });
  const base = `0000010e-00ff-4000-8000-`;
  const [empresa, ficha] = [`${base}0000000000c9`, `${base}0000000c0c09`];
  await db.raw.exec(`
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${empresa}', 'Marca del catálogo', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${a.id}', '${empresa}'), ('${b.id}', '${empresa}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${ficha}', '${empresa}', NULL, 'Prensa Catálogo', 'prensa@catalogo-r3b.test', 'press');
  `);
  const enrA = await enroll(a, bogota('2026-09-23', '07:00'), [ficha]);
  const fakeA = fakeChannels();
  await runDispatch(motor, deps(a, fakeA, () => bogota('2026-09-23', '12:00')));
  const hilo = fakeA.email.sent.find((m) => m.recipient === 'prensa@catalogo-r3b.test')!.threadRef;
  fakeA.email.reply(hilo, 'Gracias, pero no me escriban más.', bogota('2026-09-23', '13:00'));
  const r = await runReplies(motor, { readers: fakeA, now: () => bogota('2026-09-23', '14:00'), workspaceId: a.id });
  assert.equal(r.optOuts, 1);

  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [ficha]), false, 'la ficha compartida no se marca');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enrA.get(ficha)]), 'opted_out');
  // A no la vuelve a enrolar, ni en otra secuencia: su enrolamiento en opted_out la protege.
  const otraA = `${a.id.slice(0, 24)}0000005e0009`;
  await db.raw.exec(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode) VALUES ('${otraA}', '${a.id}', 'Otra', 'email', 'active', 'auto');
    INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, subject_template,
                               body_template, generate_with_ai)
    VALUES ('${a.id}', '${otraA}', 0, 0, 'email', 'email', '10:00', 'Hola', 'Hola.', false);
  `);
  const deNuevo = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: otraA, contactIds: [ficha], now: bogota('2026-09-24', '07:00') }));
  assert.deepEqual(deNuevo.skipped, [{ contactId: ficha, reason: 'opted_out' }]);
  // B, que no recibió esa respuesta, sí la enrola y le escribe.
  const enrB = await enroll(b, bogota('2026-09-24', '07:00'), [ficha]);
  assert.ok(enrB.get(ficha));
  const fakeB = fakeChannels();
  const rB = await runDispatch(motor, deps(b, fakeB, () => bogota('2026-09-24', '12:00')));
  assert.equal(rB.sent.length, 1);
  assert.equal(fakeB.email.sent[0]!.recipient, 'prensa@catalogo-r3b.test');
});

// ---------------------------------------------------------------------
// Un intento sin confirmar lo resuelve una persona (hallazgo 4)
// ---------------------------------------------------------------------

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

test('«sí salió»: queda enviado sin reenviar, su enlace de baja cuenta y la cadencia sigue con el paso de detrás', async () => {
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

  // El paso de detrás (la respuesta en el hilo) ya no espera a nadie.
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(r.sent.length, 1);
  assert.equal(fake.email.sent.length, 2, 'el intento 1 y el paso 2: nada repetido');
  assert.deepEqual((await touches(contact)).map((t) => t.status), ['sent', 'sent', 'scheduled']);
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
    VALUES ('${acc}', '${w.id}', 'linkedin', 'unipile', 'uni-linkedin-r3b-${w.n}', 'Creadora ${w.n}', 'connected', 25, 100);
    UPDATE contact SET linkedin_url = 'https://www.linkedin.com/in/persona-r3b' WHERE id = '${c}';
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
  api.addAccount({ id: `uni-linkedin-r3b-${w.n}` });
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
  const { w, touch } = await retenidoSinConfirmar(8);
  const otro = await workspace(9, { contacts: 1 });
  assert.deepEqual(await resolver(otro, touch, 'was_sent'), { ok: false, code: 'not_found' }, 'otro workspace no lo ve');
  await enroll(otro, bogota('2026-09-23', '07:00'));
  const [normal] = await touches(otro.contacts[0]!);
  assert.deepEqual(await resolver(otro, normal!.id, 'resend'), { ok: false, code: 'not_unconfirmed' });
  await db.raw.query(`UPDATE contact SET opted_out = true WHERE owner_workspace_id = $1`, [w.id]);
  assert.deepEqual(await resolver(w, touch, 'was_sent'), { ok: false, code: 'opted_out' });
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_touch WHERE id = $1`, [touch]), 'held');
});

// ---------------------------------------------------------------------
// Una dirección mal escrita (de la r2 rehecha)
// ---------------------------------------------------------------------

test('una ficha con el correo mal escrito se salta y el resto del lote sale; al enrolar se dice invalid_address', async () => {
  const w = await workspace(10, { contacts: 2 });
  const [c1, c2] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  await db.raw.query(`UPDATE contact SET email = 'carla arroba marca.test' WHERE id = $1`, [c1]);
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1, 'la otra sale: el lote no se cae');
  assert.equal(r.claim.skippedInvalidAddress, 1);
  const [t1] = await touches(c1);
  assert.deepEqual([t1!.status, t1!.blocked_reason], ['skipped', 'invalid_address']);
  assert.equal((await touches(c2))[0]!.status, 'sent');

  const nuevo = `${w.id.slice(0, 24)}0000000c0f0f`;
  await db.raw.exec(`INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
                     VALUES ('${nuevo}', '${w.company}', '${w.id}', 'Mal Escrita', 'sin-arroba.marca.test', 'user_provided')`);
  const e = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [nuevo], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual(e.skipped, [{ contactId: nuevo, reason: 'invalid_address' }]);
});
