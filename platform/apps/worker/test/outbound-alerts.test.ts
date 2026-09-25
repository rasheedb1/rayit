/**
 * VEN-15 · outbound.alerts sobre Postgres embebido, como mc_worker.
 *
 * El «terminado cuando»: con un fixture de salud (test/fixtures/
 * salud-outreach.json) el job produce las notificaciones correctas una
 * sola vez. Además: el resumen sale en UN correo a todos los dueños y
 * queda anotado (emailed_at); sin SMTP no sale y se manda en la corrida
 * siguiente con cartero, aunque sea otro día; si el correo falla no se
 * marca nada y nadie lo recibe dos veces; el día siguiente vuelve a
 * avisar; antes de la hora local no se revisa; un workspace en inglés lo
 * recibe en inglés; cada alerta lleva su enlace; con la base real
 * (outbound_health) una cuenta por reconectar produce su alerta, que dice
 * cuál es; y sin APP_URL el resumen sale sin enlaces y el job lo avisa.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AlertInput } from '@mc/core/outreach/deliverability';
import { allJobs } from '../src/jobs/index.ts';
import { missingMailConfig, smtpMailerFromEnv, type Mailer, type MailMessage } from '../src/jobs/ventas/correo.ts';
import { ALERT_TEXTS_EN, ALERT_TEXTS_ES, ALERTAS_URL, SALUD_URL, fillTemplate } from '../src/jobs/ventas/messages.ts';
import { ALERTAS_JOB_ID, createAlertasJob, runAlertas, type ReadSignals } from '../src/jobs/ventas/outbound.alerts.ts';
import type { JobContext } from '../src/runner/registry.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

/** 9:00 en Bogotá. */
const NOW = new Date('2026-09-23T14:00:00Z');
const MANANA = new Date('2026-09-24T14:00:00Z');
const WS_MAL = '0000015a-0000-4000-8000-000000000001';
const WS_SANO = '0000015a-0000-4000-8000-000000000002';
const WS_REAL = '0000015a-0000-4000-8000-000000000003';
const WS_DOS = '0000015a-0000-4000-8000-000000000004';
const WS_EN = '0000015a-0000-4000-8000-000000000005';
const USER_DUENA = '0000015a-0000-4000-8000-0000000000a1';
const USER_MIEMBRO = '0000015a-0000-4000-8000-0000000000a2';
const USER_DUENO_1 = '0000015a-0000-4000-8000-0000000000a3';
const USER_DUENO_2 = '0000015a-0000-4000-8000-0000000000a4';
const USER_OWNER_EN = '0000015a-0000-4000-8000-0000000000a5';

const SALUD = JSON.parse(readFileSync(new URL('./fixtures/salud-outreach.json', import.meta.url), 'utf8')) as Record<
  'enProblemas' | 'sano' | 'todoMal',
  AlertInput
>;

/** La salud grabada de cada workspace de fixture. */
const EN_PROBLEMAS = new Set([WS_MAL, WS_DOS, WS_EN]);
const WS_TODO = '0000015a-0000-4000-8000-000000000007';
const WS_TARDE = '0000015a-0000-4000-8000-000000000008';
const desdeFixture: ReadSignals = async (_tx, ws) =>
  ws === WS_TODO ? SALUD.todoMal : EN_PROBLEMAS.has(ws) ? SALUD.enProblemas : SALUD.sano;

class CarteroFalso implements Mailer {
  enviados: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.enviados.push(msg);
  }
}

/** Un SMTP caído: cada envío falla. */
class CarteroCaido implements Mailer {
  intentos = 0;
  async send(): Promise<void> {
    this.intentos++;
    throw new Error('SMTP caído');
  }
}

let db: PgliteDatabase;

before(async () => {
  db = await openTestDatabase();
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone, locale) VALUES
      ('${WS_MAL}', 'alertas-mal', 'Laura Creadora', 'America/Bogota', 'es-CO'),
      ('${WS_SANO}', 'alertas-sano', 'Agencia Sana', 'America/Bogota', 'es-CO'),
      ('${WS_REAL}', 'alertas-real', 'Creador Real', 'America/Bogota', 'es-CO');
    INSERT INTO app_user (id, email, name) VALUES
      ('${USER_DUENA}', 'laura@alertas.test', 'Laura'),
      ('${USER_MIEMBRO}', 'ana@alertas.test', 'Ana');
    INSERT INTO membership (workspace_id, user_id, role) VALUES
      ('${WS_MAL}', '${USER_DUENA}', 'owner'),
      ('${WS_MAL}', '${USER_MIEMBRO}', 'member');
    INSERT INTO outbound_policy (workspace_id) VALUES ('${WS_MAL}'), ('${WS_SANO}');
  `);
});
after(async () => {
  await db?.close();
});

async function avisos(ws: string) {
  const { rows } = await db.raw.query<{
    kind: string; severity: string; title_es: string; body_es: string | null; action_url: string; emailed_at: string | null;
  }>(
    `SELECT kind, severity, title_es, body_es, action_url, emailed_at::text FROM notification WHERE workspace_id = '${ws}' ORDER BY created_at, kind`,
  );
  return rows;
}

test('los plurales salen de Intl.PluralRules del locale, con 1 y con 2 (r4)', () => {
  const es = ALERT_TEXTS_ES.alerts.queue_stuck;
  const en = ALERT_TEXTS_EN.alerts.queue_stuck;
  const con = (n: number) => [{ stuck: String(n) }, { stuck: n }] as const;
  assert.equal(fillTemplate(es.body, ...con(1), 'es-CO'), '1 mensaje lleva más de cinco minutos enviándose. Si sigue así, revisa el canal.');
  assert.equal(fillTemplate(es.body, ...con(2), 'es-CO'), '2 mensajes llevan más de cinco minutos enviándose. Si sigue así, revisa el canal.');
  assert.equal(fillTemplate(en.body, ...con(1), 'en-US'), '1 message has been sending for more than five minutes. If it keeps up, check the channel.');
  assert.equal(fillTemplate(en.body, ...con(2), 'en-US'), '2 messages have been sending for more than five minutes. If it keeps up, check the channel.');
  const noSends = ALERT_TEXTS_ES.alerts.no_sends.body;
  assert.match(fillTemplate(noSends, { dueToSend: '1' }, { dueToSend: 1 }, 'es-CO'), /^Había 1 mensaje por salir y no salió en 24 horas/);
  assert.match(fillTemplate(noSends, { dueToSend: '2' }, { dueToSend: 2 }, 'es-CO'), /^Había 2 mensajes por salir/);
  const bounces = ALERT_TEXTS_ES.alerts.bounce_rate.body;
  assert.match(fillTemplate(bounces, { bounces: '1', attempts: '12' }, { bounces: 1 }, 'es-CO'), /^1 de 12 correos .* rebotó porque/);
  assert.match(fillTemplate(bounces, { bounces: '2', attempts: '12' }, { bounces: 2 }, 'es-CO'), /^2 de 12 correos .* rebotaron porque/);
  const subject = ALERT_TEXTS_ES.email.subject;
  assert.equal(fillTemplate(subject, { n: '1', workspace: 'X' }, { n: 1 }, 'es-CO'), 'On Cue · Una alerta del outreach de X');
  assert.equal(fillTemplate(subject, { n: '2', workspace: 'X' }, { n: 2 }, 'es-CO'), 'On Cue · 2 alertas del outreach de X');
});

test('el job está registrado y corre cada hora (0038)', async () => {
  assert.ok(allJobs.some((j) => j.id === ALERTAS_JOB_ID));
  const { rows } = await db.raw.query<{ default_cron: string }>('SELECT default_cron FROM job_definition WHERE id = $1', [ALERTAS_JOB_ID]);
  assert.equal(rows[0]?.default_cron, '25 * * * *');
});

test('antes de la hora local no se revisa', async () => {
  // 7:00 en Bogotá.
  const r = await runAlertas(db, new Date('2026-09-23T12:00:00Z'), { mailer: null, appUrl: 'http://x.test', readSignals: desdeFixture });
  assert.equal(r.workspaces, 0);
});

test('sin SMTP las alertas quedan, y el resumen no sale', async () => {
  const r = await runAlertas(db, NOW, { mailer: null, appUrl: 'http://localhost:3100', readSignals: desdeFixture });
  assert.deepEqual(r.created, { bounce_rate: 1, account_down: 1 });
  assert.equal(r.emailSkipped, 1);
  const mal = await avisos(WS_MAL);
  assert.deepEqual(mal.map((a) => [a.kind, a.severity]), [
    ['outreach_account_down', 'critical'],
    ['outreach_bounce_rate', 'critical'],
  ]);
  assert.match(mal[1]?.title_es ?? '', /Rebotan demasiados correos: 15\s?%/);
  assert.ok(mal.every((a) => a.emailed_at === null));
  assert.deepEqual(await avisos(WS_SANO), []);
});

test('cada alerta lleva su propio enlace, a una pantalla que existe', async () => {
  const mal = await avisos(WS_MAL);
  assert.deepEqual(mal.map((a) => a.action_url), [ALERTAS_URL.account_down, ALERTAS_URL.bounce_rate]);
  assert.ok(mal.every((a) => a.action_url.startsWith('/ventas/politica')), 'no a /ventas/canales hasta que VEN-9 la integre');
});

test('la corrida siguiente, con cartero, no repite avisos y manda el resumen una vez a la dueña', async () => {
  const cartero = new CarteroFalso();
  const r = await runAlertas(db, NOW, { mailer: cartero, appUrl: 'http://localhost:3100/', readSignals: desdeFixture });
  assert.deepEqual(r.created, {});
  assert.equal(cartero.enviados.length, 1);
  const [correo] = cartero.enviados;
  assert.deepEqual(correo?.to, ['laura@alertas.test']);
  assert.equal(correo?.subject, 'On Cue · 2 alertas del outreach de Laura Creadora');
  assert.match(correo?.text ?? '', /3 de 20 correos enviados/);
  assert.ok((correo?.text ?? '').includes(`http://localhost:3100${SALUD_URL}`), 'el enlace de cada alerta, no uno fijo');
  assert.ok((await avisos(WS_MAL)).every((a) => a.emailed_at !== null));

  // Otra vez el mismo día: ni avisos ni correo.
  const otra = new CarteroFalso();
  const r2 = await runAlertas(db, new Date('2026-09-23T20:00:00Z'), { mailer: otra, appUrl: 'http://x.test', readSignals: desdeFixture });
  assert.deepEqual(r2.created, {});
  assert.equal(otra.enviados.length, 0);
  assert.equal((await avisos(WS_MAL)).length, 2);
});

test('al día siguiente, si sigue mal, vuelve a avisar', async () => {
  const cartero = new CarteroFalso();
  const r = await runAlertas(db, MANANA, { mailer: cartero, appUrl: 'http://x.test', readSignals: desdeFixture });
  assert.deepEqual(r.created, { bounce_rate: 1, account_down: 1 });
  assert.equal(cartero.enviados.length, 1);
  assert.equal((await avisos(WS_MAL)).length, 4);
});

test('con la base real: una cuenta por reconectar da su alerta (outbound_health)', async () => {
  await db.raw.exec(`
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, display_name, status)
    VALUES ('${WS_REAL}', 'linkedin', 'unipile', 'unipile-real-1', 'Creador Real', 'needs_reconnect');
  `);
  const r = await runAlertas(db, NOW, { mailer: null, appUrl: 'http://x.test' });
  assert.equal(r.created.account_down, 1);
  const real = await avisos(WS_REAL);
  assert.deepEqual(real.map((a) => a.kind), ['outreach_account_down']);
  // Dice CUÁL es, y lleva a donde se ve qué dijo el proveedor (no a una pantalla que no la nombra).
  assert.match(real[0]?.body_es ?? '', /No sale nada por LinkedIn: Creador Real hasta que se reconecte/);
  assert.equal(real[0]?.action_url, '/ventas/politica#cuentas');
});

test('con dos dueños: si el correo falla nadie lo recibe dos veces, y sale al día siguiente en un solo correo', async () => {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone, locale) VALUES ('${WS_DOS}', 'alertas-dos', 'Dos Dueños', 'America/Bogota', 'es-CO');
    INSERT INTO app_user (id, email, name) VALUES
      ('${USER_DUENO_1}', 'uno@alertas.test', 'Uno'), ('${USER_DUENO_2}', 'dos@alertas.test', 'Dos');
    INSERT INTO membership (workspace_id, user_id, role) VALUES
      ('${WS_DOS}', '${USER_DUENO_1}', 'owner'), ('${WS_DOS}', '${USER_DUENO_2}', 'owner');
    INSERT INTO outbound_policy (workspace_id) VALUES ('${WS_DOS}');
  `);
  const caido = new CarteroCaido();
  const r = await runAlertas(db, new Date('2026-09-25T14:00:00Z'), { mailer: caido, appUrl: 'http://x.test', readSignals: desdeFixture });
  assert.ok(r.emailFailed >= 1);
  assert.ok((await avisos(WS_DOS)).every((a) => a.emailed_at === null), 'nada queda marcado si el correo no salió');

  // Al día siguiente, con SMTP: las alertas de ayer y las de hoy, en UN correo a los dos.
  const cartero = new CarteroFalso();
  await runAlertas(db, new Date('2026-09-26T14:00:00Z'), { mailer: cartero, appUrl: 'http://x.test', readSignals: desdeFixture });
  const deDos = cartero.enviados.filter((m) => m.subject.includes('Dos Dueños'));
  assert.equal(deDos.length, 1);
  assert.deepEqual(deDos[0]?.to, ['dos@alertas.test', 'uno@alertas.test']);
  assert.equal(deDos[0]?.subject, 'On Cue · 4 alertas del outreach de Dos Dueños');
  const dos = await avisos(WS_DOS);
  assert.equal(dos.length, 4);
  assert.ok(dos.every((a) => a.emailed_at !== null));
});

test('un workspace en inglés recibe los avisos y el correo en inglés', async () => {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone, locale) VALUES ('${WS_EN}', 'alerts-en', 'Creator EN', 'America/New_York', 'en-US');
    INSERT INTO app_user (id, email, name) VALUES ('${USER_OWNER_EN}', 'owner@alerts.test', 'Owner');
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS_EN}', '${USER_OWNER_EN}', 'owner');
    INSERT INTO outbound_policy (workspace_id) VALUES ('${WS_EN}');
  `);
  const cartero = new CarteroFalso();
  // 10:00 en Nueva York.
  await runAlertas(db, new Date('2026-09-27T14:00:00Z'), { mailer: cartero, appUrl: 'https://app.test', readSignals: desdeFixture });
  const [correo] = cartero.enviados.filter((m) => m.subject.includes('Creator EN'));
  assert.equal(correo?.subject, 'On Cue · 2 outreach alerts for Creator EN');
  assert.match(correo?.text ?? '', /3 of 20 emails sent in the last 24 hours bounced/);
  const en = await avisos(WS_EN);
  assert.ok(en.some((a) => /^Too many emails are bouncing: 15\s?%$/.test(a.title_es)));
});

test('sin APP_URL el job lo avisa en el registro y el resumen sale sin enlaces (nada de localhost)', async () => {
  const WS_SIN_URL = '0000015a-0000-4000-8000-000000000006';
  const USER_SIN_URL = '0000015a-0000-4000-8000-0000000000a6';
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone, locale) VALUES ('${WS_SIN_URL}', 'alertas-sin-url', 'Sin URL', 'America/Bogota', 'es-CO');
    INSERT INTO app_user (id, email, name) VALUES ('${USER_SIN_URL}', 'sin-url@alertas.test', 'Sin URL');
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS_SIN_URL}', '${USER_SIN_URL}', 'owner');
    INSERT INTO outbound_policy (workspace_id) VALUES ('${WS_SIN_URL}');
  `);
  const cartero = new CarteroFalso();
  const avisosDelRegistro: string[] = [];
  const logger = {
    level: 'info',
    debug: () => {},
    info: () => {},
    warn: (msg: string) => avisosDelRegistro.push(msg),
    error: () => {},
    child: () => logger,
  } as unknown as JobContext['logger'];
  const job = createAlertasJob({
    readSignals: async (_tx, ws) => (ws === WS_SIN_URL ? SALUD.enProblemas : SALUD.sano),
    mailerFromEnv: () => cartero,
  });
  const ctx = {
    db,
    logger,
    env: {},
    signal: new AbortController().signal,
    now: () => new Date('2026-09-28T14:00:00Z'),
  } as unknown as JobContext;
  await job.handler({}, ctx);
  assert.ok(avisosDelRegistro.some((m) => /sin APP_URL/.test(m)), 'lo dice en el registro');
  const [correo] = cartero.enviados.filter((m) => m.subject.includes('Sin URL'));
  assert.ok(correo, 'el resumen sale igual');
  assert.doesNotMatch(correo.text, /https?:\/\//, 'ningún enlace, tampoco a localhost');
  assert.match(correo.text, /Lo ves en On Cue, en Ventas → Política de envío\./);
  assert.ok((await avisos(WS_SIN_URL)).every((a) => a.emailed_at !== null));
});

/** Un workspace con dueña y política, sin cuentas en la base: la salud llega del fixture. */
async function espacioDeFixture(ws: string, user: string, slug: string, name: string): Promise<void> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone, locale) VALUES ('${ws}', '${slug}', '${name}', 'America/Bogota', 'es-CO');
    INSERT INTO app_user (id, email, name) VALUES ('${user}', '${slug}@alertas.test', '${name}');
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${ws}', '${user}', 'owner');
    INSERT INTO outbound_policy (workspace_id) VALUES ('${ws}');
  `);
}

test('todo mal (r4, r5): el fixture da las seis notificaciones, con su gravedad, su enlace y sus cifras, una sola vez', async () => {
  await espacioDeFixture(WS_TODO, '0000015a-0000-4000-8000-0000000000a7', 'alertas-todo', 'Todo Mal');
  const cartero = new CarteroFalso();
  // La inserción pasa el CHECK de notification.kind para los seis tipos: si no, el workspace falla entero.
  const fallos: unknown[] = [];
  await runAlertas(db, new Date('2026-10-01T14:00:00Z'), { mailer: cartero, appUrl: 'https://app.test', readSignals: desdeFixture }, (_ws, e) =>
    fallos.push(e),
  );
  assert.deepEqual(fallos, []);

  const todo = await avisos(WS_TODO);
  const porTipo = Object.fromEntries(todo.map((a) => [a.kind, a]));
  assert.deepEqual(
    todo.map((a) => [a.kind, a.severity, a.action_url]).sort(),
    [
      ['outreach_account_down', 'critical', '/ventas/politica#cuentas'],
      ['outreach_bounce_rate', 'critical', '/ventas/politica#salud'],
      ['outreach_bounces_unread', 'warning', '/ventas/politica#salud'],
      ['outreach_llm_budget', 'warning', '/ventas/politica#presupuesto'],
      ['outreach_no_sends', 'warning', '/ventas/politica#salud'],
      ['outreach_queue_stuck', 'warning', '/ventas/politica#salud'],
    ],
  );
  // Ninguna {variable} sin rellenar, ni en el título ni en el cuerpo.
  for (const a of todo) {
    assert.ok(!a.title_es.includes('{'), `título sin rellenar: ${a.title_es}`);
    assert.ok(!(a.body_es ?? '').includes('{'), `cuerpo sin rellenar: ${a.body_es}`);
  }
  // Las cifras, con Intl y con su plural; el dinero en la moneda del presupuesto (USD) y el locale del espacio.
  const usd = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD' });
  assert.equal(
    porTipo['outreach_llm_budget']?.body_es,
    `Se gastaron ${usd.format(5.2)} de ${usd.format(5)} hoy. Los mensajes nuevos esperan a mañana; lo aprobado sigue saliendo.`,
  );
  assert.equal(porTipo['outreach_queue_stuck']?.title_es, 'Hay un mensaje atascado en la cola');
  assert.match(porTipo['outreach_queue_stuck']?.body_es ?? '', /^1 mensaje lleva más de cinco minutos/);
  assert.match(porTipo['outreach_no_sends']?.body_es ?? '', /^Había 7 mensajes por salir y no salió ninguno/);
  assert.match(porTipo['outreach_account_down']?.body_es ?? '', /^No sale nada por una cuenta de canal hasta que se reconecte/);
  assert.match(porTipo['outreach_bounce_rate']?.body_es ?? '', /^3 de 20 correos enviados en las últimas 24 horas rebotaron/);
  assert.equal(porTipo['outreach_bounces_unread']?.title_es, 'No estamos leyendo los rebotes de tu Gmail');
  assert.match(porTipo['outreach_bounces_unread']?.body_es ?? '', /^Los avisos de rebote de 1 cuenta de Gmail no se están leyendo/);

  // El correo de resumen lista las seis, cada una con su enlace.
  const [correo] = cartero.enviados.filter((m) => m.subject.includes('Todo Mal'));
  assert.equal(correo?.subject, 'On Cue · 6 alertas del outreach de Todo Mal');
  for (const a of todo) {
    assert.ok(correo?.text.includes(`· ${a.title_es}`), `el correo lista «${a.title_es}»`);
    assert.ok(correo?.text.includes(`https://app.test${a.action_url}`));
  }

  // Una segunda corrida el mismo día no crea ninguna ni manda otro correo.
  const otra = new CarteroFalso();
  await runAlertas(db, new Date('2026-10-01T18:00:00Z'), { mailer: otra, appUrl: 'https://app.test', readSignals: desdeFixture });
  assert.equal((await avisos(WS_TODO)).length, 6);
  assert.equal(otra.enviados.filter((m) => m.subject.includes('Todo Mal')).length, 0);
});

test('un resumen por día (r4), y lo urgente no espera a mañana (r5)', async () => {
  await espacioDeFixture(WS_TARDE, '0000015a-0000-4000-8000-0000000000a8', 'alertas-tarde', 'Por La Tarde');
  const soloRebotes: AlertInput = { ...SALUD.enProblemas, health: { ...SALUD.enProblemas.health, accountsDown: 0 } };
  let salud: AlertInput = soloRebotes;
  const leer: ReadSignals = async (_tx, ws) => (ws === WS_TARDE ? salud : SALUD.sano);
  const deTarde = (c: CarteroFalso) => c.enviados.filter((m) => m.subject.includes('Por La Tarde'));

  // 8:00 en Bogotá: rebotes. Sale el resumen, con una alerta.
  const manana = new CarteroFalso();
  await runAlertas(db, new Date('2026-10-03T13:00:00Z'), { mailer: manana, appUrl: 'https://app.test', readSignals: leer });
  assert.equal(deTarde(manana).length, 1);
  assert.equal(deTarde(manana)[0]?.subject, 'On Cue · Una alerta del outreach de Por La Tarde');

  // 15:00: cae una cuenta y se atasca un mensaje. La cuenta caída es urgente:
  // sale ya, en un correo corto aparte. El atasco espera al resumen de mañana.
  salud = { ...soloRebotes, health: { ...soloRebotes.health, accountsDown: 1, queue: { stuck: 2 } } };
  const tarde = new CarteroFalso();
  const r = await runAlertas(db, new Date('2026-10-03T20:00:00Z'), { mailer: tarde, appUrl: 'https://app.test', readSignals: leer });
  assert.equal(r.created.account_down, 1);
  assert.equal(r.created.queue_stuck, 1);
  assert.equal(r.urgentSent, 1);
  assert.ok(r.emailDeferred >= 1, 'el atasco espera');
  const [urgente] = deTarde(tarde);
  assert.equal(deTarde(tarde).length, 1);
  assert.equal(urgente?.subject, 'On Cue · Alerta urgente del outreach de Por La Tarde');
  assert.match(urgente?.text ?? '', /Una cuenta de envío necesita atención/);
  assert.doesNotMatch(urgente?.text ?? '', /atascado/, 'solo lo urgente');
  assert.deepEqual(
    (await avisos(WS_TARDE)).map((a) => [a.kind, a.emailed_at === null]),
    [
      ['outreach_bounce_rate', false],
      ['outreach_account_down', false],
      ['outreach_queue_stuck', true],
    ],
  );

  // 17:00: nada nuevo. Ni la cuenta caída se repite ni el atasco sale hoy.
  const luego = new CarteroFalso();
  await runAlertas(db, new Date('2026-10-03T22:00:00Z'), { mailer: luego, appUrl: 'https://app.test', readSignals: leer });
  assert.equal(deTarde(luego).length, 0);

  // Al día siguiente, a las 8:00, la cuenta sigue caída: el resumen trae el atasco de ayer y la cuenta de hoy.
  salud = { ...SALUD.sano, health: { ...SALUD.sano.health, accountsDown: 1 } };
  const otroDia = new CarteroFalso();
  await runAlertas(db, new Date('2026-10-04T13:00:00Z'), { mailer: otroDia, appUrl: 'https://app.test', readSignals: leer });
  assert.equal(deTarde(otroDia).length, 1);
  assert.equal(deTarde(otroDia)[0]?.subject, 'On Cue · 2 alertas del outreach de Por La Tarde');
  assert.ok((await avisos(WS_TARDE)).every((a) => a.emailed_at !== null));
});


test('con la base real (r5): un Gmail conectado cuyo buzón de rebotes nadie lee da su alerta; leído hace poco, no', async () => {
  const WS_GMAIL = '0000015a-0000-4000-8000-000000000009';
  await espacioDeFixture(WS_GMAIL, '0000015a-0000-4000-8000-0000000000a9', 'alertas-gmail', 'Sin Leer');
  await db.raw.exec(`
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, display_name, status)
    VALUES ('${WS_GMAIL}', 'email', 'gmail_oauth', 'sinleer@alertas.test', NULL, 'connected');
  `);
  const r = await runAlertas(db, new Date('2026-11-10T14:00:00Z'), { mailer: null, appUrl: 'https://app.test' });
  assert.ok((r.created.bounces_unread ?? 0) >= 1);
  const sinLeer = (await avisos(WS_GMAIL)).filter((a) => a.kind === 'outreach_bounces_unread');
  assert.equal(sinLeer.length, 1);
  assert.equal(sinLeer[0]?.action_url, SALUD_URL);

  // Leído hace media hora: al día siguiente ya no avisa.
  await db.raw.exec(`UPDATE outreach_channel_account SET bounces_read_at = '2026-11-11T13:30:00Z'
                      WHERE provider_account_id = 'sinleer@alertas.test'`);
  await runAlertas(db, new Date('2026-11-11T14:00:00Z'), { mailer: null, appUrl: 'https://app.test' });
  assert.equal((await avisos(WS_GMAIL)).filter((a) => a.kind === 'outreach_bounces_unread').length, 1);
});

test('dos corridas que se solapan mandan UN solo resumen: leer, enviar y marcar van bajo el mismo candado', async () => {
  const WS_DOBLE = '0000015a-0000-4000-8000-00000000000a';
  await espacioDeFixture(WS_DOBLE, '0000015a-0000-4000-8000-0000000000aa', 'alertas-doble', 'Dos Corridas');
  const leer: ReadSignals = async (_tx, ws) => (ws === WS_DOBLE ? SALUD.enProblemas : SALUD.sano);
  /** Un SMTP lento: mientras envía, la otra corrida tendría tiempo de leer los mismos pendientes. */
  class CarteroLento extends CarteroFalso {
    override async send(msg: MailMessage): Promise<void> {
      await new Promise((ok) => setTimeout(ok, 30));
      await super.send(msg);
    }
  }
  const cartero = new CarteroLento();
  const cuando = new Date('2026-12-06T14:00:00Z');
  const deps = { mailer: cartero, appUrl: 'https://app.test', readSignals: leer };
  await Promise.all([runAlertas(db, cuando, deps), runAlertas(db, cuando, deps)]);
  assert.equal(cartero.enviados.filter((m) => m.subject.includes('Dos Corridas')).length, 1, 'un solo correo');
  assert.ok((await avisos(WS_DOBLE)).every((x) => x.emailed_at !== null));
});

test('en producción sin MAIL_FROM el resumen no sale (un remitente .invalid rebota): lo dicen el registro y el resultado', async () => {
  const WS_SIN_FROM = '0000015a-0000-4000-8000-00000000000b';
  await espacioDeFixture(WS_SIN_FROM, '0000015a-0000-4000-8000-0000000000ab', 'alertas-sin-from', 'Sin Remitente');
  const cartero = new CarteroFalso();
  const registro: string[] = [];
  const logger = {
    level: 'info',
    debug: () => {},
    info: (msg: string) => registro.push(msg),
    warn: (msg: string) => registro.push(msg),
    error: () => {},
    child: () => logger,
  } as unknown as JobContext['logger'];
  const job = createAlertasJob({
    readSignals: async (_tx, ws) => (ws === WS_SIN_FROM ? SALUD.enProblemas : SALUD.sano),
    mailerFromEnv: () => cartero,
  });
  const ctx = {
    db,
    logger,
    env: { NODE_ENV: 'production', SMTP_URL: 'smtp://smtp.ejemplo.test:587', APP_URL: 'https://app.test' },
    signal: new AbortController().signal,
    now: () => new Date('2026-12-07T14:00:00Z'),
  } as unknown as JobContext;
  const out = (await job.handler({}, ctx)) as { metadata?: { emailSkipped?: number; emailSkippedReason?: string | null } };
  assert.equal(cartero.enviados.filter((m) => m.subject.includes('Sin Remitente')).length, 0, 'no sale');
  assert.ok(registro.some((m) => /MAIL_FROM sin configurar/.test(m)));
  assert.ok((out.metadata?.emailSkipped ?? 0) >= 1);
  assert.equal(out.metadata?.emailSkippedReason, 'MAIL_FROM');
  // Quedan sin marcar: salen cuando se configure.
  assert.ok((await avisos(WS_SIN_FROM)).every((x) => x.emailed_at === null));
});

test('smtpMailerFromEnv: sin SMTP_URL no hay cartero; en producción tampoco sin MAIL_FROM; en local basta SMTP_URL', () => {
  assert.equal(missingMailConfig({}), 'SMTP_URL');
  assert.equal(missingMailConfig({ NODE_ENV: 'production', SMTP_URL: 'smtp://x.test:587' }), 'MAIL_FROM');
  assert.equal(smtpMailerFromEnv({ NODE_ENV: 'production', SMTP_URL: 'smtp://x.test:587' }), null);
  assert.equal(missingMailConfig({ NODE_ENV: 'development', SMTP_URL: 'smtp://localhost:1025' }), null);
  assert.equal(missingMailConfig({ NODE_ENV: 'production', SMTP_URL: 'smtp://x.test:587', MAIL_FROM: 'On Cue <hola@oncue.app>' }), null);
});
