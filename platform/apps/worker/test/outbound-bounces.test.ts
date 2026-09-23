/**
 * VEN-15 · outbound.bounces sobre Postgres embebido, como mc_worker, con
 * un buzón de avisos grabados (test/fixtures/rebotes/buzon.json).
 *
 * El «terminado cuando»: un rebote de fixture marca el correo inválido y
 * cancela los correos pendientes de esa ficha. Además: LinkedIn sigue; un
 * rebote blando se anota y no marca nada; una respuesta normal no es un
 * rebote; leer el buzón otra vez no cuenta dos rebotes; y sin conector de
 * Gmail el canal cuenta como no configurado.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allJobs } from '../src/jobs/index.ts';
import {
  BOUNCES_JOB_ID, gmailNoConfigurado, runBounces, type BounceMailbox, type BounceMessage, type MailboxFor,
} from '../src/jobs/ventas/outbound.bounces.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

const NOW = new Date('2026-09-23T14:00:00Z');
const WS = '0000015b-0000-4000-8000-000000000001';
const COMPANY = '0000015b-0000-4000-8000-0000000000c1';
const ACCOUNT = '0000015b-0000-4000-8000-00000000acc1';
const C_DURO = '0000015b-0000-4000-8000-0000000000a1';
const C_LLENO = '0000015b-0000-4000-8000-0000000000a2';
const T_ENVIADO = '0000015b-0000-4000-8000-0000000070a1';
const T_CORREO = '0000015b-0000-4000-8000-0000000070a2';
const T_BORRADOR = '0000015b-0000-4000-8000-0000000070a3';
const T_LINKEDIN = '0000015b-0000-4000-8000-0000000070a4';
const T_LLENO = '0000015b-0000-4000-8000-0000000070b1';

const AVISOS: BounceMessage[] = (
  JSON.parse(readFileSync(new URL('./fixtures/rebotes/buzon.json', import.meta.url), 'utf8')) as Array<
    Omit<BounceMessage, 'receivedAt'> & { receivedAt: string }
  >
).map((m) => ({ ...m, receivedAt: new Date(m.receivedAt) }));

/** El buzón grabado: devuelve lo recibido desde `since` y anota cada lectura. */
class BuzonGrabado implements BounceMailbox {
  lecturas: Date[] = [];
  async listBounceCandidates({ since }: { since: Date }): Promise<BounceMessage[]> {
    this.lecturas.push(since);
    return AVISOS.filter((m) => m.receivedAt >= since);
  }
}

let db: PgliteDatabase;

before(async () => {
  db = await openTestDatabase();
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', 'rebotes', 'Laura', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY}', 'Marca Rebote', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${COMPANY}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${C_DURO}', '${COMPANY}', 'No existe', 'no-existe@marca-rebote.test', 'user_provided', '${WS}'),
      ('${C_LLENO}', '${COMPANY}', 'Buzón lleno', 'lleno@marca-rebote.test', 'user_provided', '${WS}');
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status)
    VALUES ('${ACCOUNT}', '${WS}', 'email', 'gmail_oauth', 'laura.creadora@gmail.com', 'connected');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for,
                                sent_at, provider_message_id, message_id_rfc, recipient_address, attempt_count) VALUES
      ('${T_ENVIADO}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'Hola', 'sent', '2026-09-23T13:00:00Z',
       '2026-09-23T13:00:00Z', 'gmail-msg-1', '<CAF=rebote001@mail.gmail.com>', 'no-existe@marca-rebote.test', 1),
      ('${T_CORREO}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'Sigo', 'scheduled', '2026-09-26T13:00:00Z',
       NULL, NULL, NULL, NULL, 0),
      ('${T_BORRADOR}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'Último', 'draft', '2026-09-30T13:00:00Z',
       NULL, NULL, NULL, NULL, 0),
      ('${T_LINKEDIN}', '${WS}', '${COMPANY}', '${C_DURO}', 'linkedin', 'Hola por aquí', 'scheduled', '2026-09-27T13:00:00Z',
       NULL, NULL, NULL, NULL, 0),
      ('${T_LLENO}', '${WS}', '${COMPANY}', '${C_LLENO}', 'email', 'Hola', 'scheduled', '2026-09-25T13:00:00Z',
       NULL, NULL, NULL, NULL, 0);
  `);
});
after(async () => {
  await db?.close();
});

async function toque(id: string) {
  const { rows } = await db.raw.query<{ status: string; blocked_reason: string | null }>(
    `SELECT status, blocked_reason FROM outbound_touch WHERE id = '${id}'`,
  );
  return rows[0];
}

test('el job está registrado y programado cada media hora (0038)', async () => {
  assert.ok(allJobs.some((j) => j.id === BOUNCES_JOB_ID));
  const { rows } = await db.raw.query<{ queue: string; default_cron: string }>(
    'SELECT queue, default_cron FROM job_definition WHERE id = $1',
    [BOUNCES_JOB_ID],
  );
  assert.deepEqual(rows[0], { queue: 'sales', default_cron: '*/30 * * * *' });
});

test('sin conector de Gmail la cuenta es «canal no configurado» y no se toca nada', async () => {
  const r = await runBounces(db, NOW, gmailNoConfigurado);
  assert.equal(r.accounts, 1);
  assert.equal(r.notConfigured, 1);
  assert.equal(r.bounces, 0);
  assert.equal((await toque(T_CORREO))?.status, 'scheduled');
});

test('un rebote duro marca el correo inválido y cancela los correos pendientes; LinkedIn sigue', async () => {
  const buzon = new BuzonGrabado();
  const r = await runBounces(db, NOW, () => buzon);
  assert.deepEqual(
    { read: r.read, bounces: r.bounces, hard: r.hard, invalidated: r.contactsInvalidated, canceled: r.touchesCanceled },
    { read: 3, bounces: 2, hard: 1, invalidated: 1, canceled: 2 },
  );
  // La primera lectura va 72 h hacia atrás.
  assert.equal(buzon.lecturas[0]?.toISOString(), '2026-09-20T14:00:00.000Z');

  const { rows: [c] } = await db.raw.query<{ email_invalid: boolean; email_invalid_reason: string; bounced: boolean }>(
    `SELECT email_invalid, email_invalid_reason, bounced FROM contact WHERE id = '${C_DURO}'`,
  );
  assert.equal(c?.email_invalid, true);
  assert.match(c?.email_invalid_reason ?? '', /5\.1\.1/);
  assert.equal(c?.bounced, true);
  assert.deepEqual(await toque(T_CORREO), { status: 'canceled', blocked_reason: 'email_invalid' });
  assert.deepEqual(await toque(T_BORRADOR), { status: 'canceled', blocked_reason: 'email_invalid' });
  assert.equal((await toque(T_ENVIADO))?.status, 'sent');
  assert.deepEqual(await toque(T_LINKEDIN), { status: 'scheduled', blocked_reason: null });

  const { rows: bitacora } = await db.raw.query<{ kind: string; touch_id: string | null; contact_id: string | null; status_code: string }>(
    `SELECT kind, touch_id, contact_id, status_code FROM outbound_bounce WHERE workspace_id = '${WS}' ORDER BY received_at`,
  );
  assert.deepEqual(bitacora, [
    { kind: 'hard', touch_id: T_ENVIADO, contact_id: C_DURO, status_code: '5.1.1' },
    { kind: 'soft', touch_id: null, contact_id: C_LLENO, status_code: '5.2.2' },
  ]);
});

test('un rebote blando se anota y no marca la ficha ni cancela nada', async () => {
  const { rows: [c] } = await db.raw.query<{ email_invalid: boolean }>(`SELECT email_invalid FROM contact WHERE id = '${C_LLENO}'`);
  assert.equal(c?.email_invalid, false);
  assert.equal((await toque(T_LLENO))?.status, 'scheduled');
});

test('leer el buzón otra vez no cuenta dos rebotes, y lee desde el último aviso con una hora de solape', async () => {
  const buzon = new BuzonGrabado();
  const r = await runBounces(db, NOW, () => buzon);
  assert.equal(r.bounces, 0);
  assert.equal(buzon.lecturas[0]?.toISOString(), '2026-09-23T12:20:00.000Z');
  const { rows: [n] } = await db.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_bounce WHERE workspace_id = '${WS}'`);
  assert.equal(n?.n, 2);
});

test('un buzón que falla no tumba la corrida', async () => {
  const roto: MailboxFor = () => ({
    listBounceCandidates: async () => {
      throw new Error('token vencido');
    },
  });
  const errores: string[] = [];
  const r = await runBounces(db, NOW, roto, { onAccountError: (a) => errores.push(a.id) });
  assert.equal(r.failed, 1);
  assert.deepEqual(errores, [ACCOUNT]);
});
