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
import type { Mailer, MailMessage } from '../src/jobs/ventas/correo.ts';
import { ALERTAS_URL, SALUD_URL } from '../src/jobs/ventas/messages.ts';
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
  'enProblemas' | 'sano',
  AlertInput
>;

/** La salud grabada de cada workspace de fixture. */
const EN_PROBLEMAS = new Set([WS_MAL, WS_DOS, WS_EN]);
const desdeFixture: ReadSignals = async (_tx, ws) => (EN_PROBLEMAS.has(ws) ? SALUD.enProblemas : SALUD.sano);

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

test('un workspace en inglés recibe la campana y el correo en inglés', async () => {
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
