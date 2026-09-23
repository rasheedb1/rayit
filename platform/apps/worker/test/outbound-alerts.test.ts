/**
 * VEN-15 · outbound.alerts sobre Postgres embebido, como mc_worker.
 *
 * El «terminado cuando»: con un fixture de salud (test/fixtures/
 * salud-outreach.json) el job produce las notificaciones correctas una
 * sola vez. Además: el resumen sale por correo una vez a cada dueño y
 * queda anotado (emailed_at); sin SMTP no sale y se manda en la corrida
 * siguiente con cartero; el día siguiente vuelve a avisar; antes de la
 * hora local no se revisa; y con la base real (outbound_health) una
 * cuenta por reconectar produce su alerta.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AlertInput } from '@mc/core/outreach/deliverability';
import { allJobs } from '../src/jobs/index.ts';
import type { Mailer, MailMessage } from '../src/jobs/ventas/correo.ts';
import { ALERTAS_JOB_ID, runAlertas, type ReadSignals } from '../src/jobs/ventas/outbound.alerts.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

/** 9:00 en Bogotá. */
const NOW = new Date('2026-09-23T14:00:00Z');
const MANANA = new Date('2026-09-24T14:00:00Z');
const WS_MAL = '0000015a-0000-4000-8000-000000000001';
const WS_SANO = '0000015a-0000-4000-8000-000000000002';
const WS_REAL = '0000015a-0000-4000-8000-000000000003';
const USER_DUENA = '0000015a-0000-4000-8000-0000000000a1';
const USER_MIEMBRO = '0000015a-0000-4000-8000-0000000000a2';

const SALUD = JSON.parse(readFileSync(new URL('./fixtures/salud-outreach.json', import.meta.url), 'utf8')) as Record<
  'enProblemas' | 'sano',
  AlertInput
>;

/** La salud grabada de cada workspace de fixture. */
const desdeFixture: ReadSignals = async (_tx, ws) => (ws === WS_MAL ? SALUD.enProblemas : SALUD.sano);

class CarteroFalso implements Mailer {
  enviados: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.enviados.push(msg);
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
  const { rows } = await db.raw.query<{ kind: string; severity: string; title_es: string; emailed_at: string | null }>(
    `SELECT kind, severity, title_es, emailed_at::text FROM notification WHERE workspace_id = '${ws}' ORDER BY created_at, kind`,
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

test('la corrida siguiente, con cartero, no repite avisos y manda el resumen una vez a la dueña', async () => {
  const cartero = new CarteroFalso();
  const r = await runAlertas(db, NOW, { mailer: cartero, appUrl: 'http://localhost:3100/', readSignals: desdeFixture });
  assert.deepEqual(r.created, {});
  assert.equal(cartero.enviados.length, 1);
  const [correo] = cartero.enviados;
  assert.equal(correo?.to, 'laura@alertas.test');
  assert.equal(correo?.subject, 'On Cue · 2 alertas del outreach de Laura Creadora');
  assert.match(correo?.text ?? '', /3 de 20 correos rebotaron/);
  assert.match(correo?.text ?? '', /http:\/\/localhost:3100\/ventas\/politica/);
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
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
    VALUES ('${WS_REAL}', 'linkedin', 'unipile', 'unipile-real-1', 'needs_reconnect');
  `);
  const r = await runAlertas(db, NOW, { mailer: null, appUrl: 'http://x.test' });
  assert.equal(r.created.account_down, 1);
  const real = await avisos(WS_REAL);
  assert.deepEqual(real.map((a) => a.kind), ['outreach_account_down']);
});
