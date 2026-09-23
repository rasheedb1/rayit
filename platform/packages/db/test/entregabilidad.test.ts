/**
 * VEN-15 · entregabilidad en Postgres embebido.
 *
 *   · la baja desde el enlace, de punta a punta: el token firmado por la
 *     plataforma, el rechazo del clic de quien envió (sin tocar nada), la
 *     ficha marcada y todo lo pendiente cancelado, en este workspace y en
 *     los demás que le escriben a la misma dirección; el segundo clic; un
 *     token con otra firma o sin correo detrás no encuentra nada;
 *   · la política editable: valores por defecto, guardar, el interruptor
 *     con dirección postal, y que no se puede quitar la dirección con el
 *     envío encendido;
 *   · contact.email_invalid (0038): no se programa un correo a un correo
 *     que rebotó, los otros canales siguen, y cambiar el correo borra la
 *     marca;
 *   · outbound_bounce: la web la lee aislada por workspace y no la escribe.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOptoutToken, optoutTokenHash } from '@mc/core/outreach/deliverability';
import {
  checkOptoutLink, getOutboundPolicy, optoutFromLink, PolicyNeedsAddressError, saveOutboundPolicy, type OptoutGates,
} from '../src/queries/entregabilidad.ts';
import { enableOutreach } from '../src/queries/outreach.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const SECRET = 'secreto-de-prueba-de-la-baja-con-32-o-mas';
const WS_S = '00000038-0000-4000-8000-00000000000a';
const WS_O = '00000038-0000-4000-8000-00000000000b';
const COMPANY = '00000038-0000-4000-8000-0000000000c1';
const CONTACT_S = '00000038-0000-4000-8000-0000000000a1';
const CONTACT_O = '00000038-0000-4000-8000-0000000000b1';
const CONTACT_REBOTE = '00000038-0000-4000-8000-0000000000a2';
const TOUCH_SENT = '00000038-0000-4000-8000-0000000070a1';
const TOUCH_PENDING = '00000038-0000-4000-8000-0000000070a2';
const TOUCH_LINKEDIN = '00000038-0000-4000-8000-0000000070a3';
const TOUCH_PENDING_O = '00000038-0000-4000-8000-0000000070b1';
const SEQ = '00000038-0000-4000-8000-0000000005a1';
const ENR = '00000038-0000-4000-8000-00000000e0a1';

const TOKEN = createOptoutToken({ workspaceId: WS_S, contactId: CONTACT_S }, SECRET);
/** Firmado por la plataforma, pero ningún correo salió con él. */
const TOKEN_SIN_CORREO = createOptoutToken({ workspaceId: WS_S, contactId: CONTACT_S }, SECRET);

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS_S}', 'baja-envia', 'Quien envía', 'America/Bogota'),
      ('${WS_O}', 'baja-otro', 'Otro creador', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY}', 'Marca de la baja', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_S}', '${COMPANY}'), ('${WS_O}', '${COMPANY}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${CONTACT_S}', '${COMPANY}', 'Valentina', 'valentina@marca.test', 'user_provided', '${WS_S}'),
      ('${CONTACT_O}', '${COMPANY}', 'Valentina (O)', 'valentina@marca.test', 'user_provided', '${WS_O}'),
      ('${CONTACT_REBOTE}', '${COMPANY}', 'Rebote', 'no-existe@marca.test', 'user_provided', '${WS_S}');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ}', '${WS_S}', 'Secuencia', 'email', 'active');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id) VALUES ('${ENR}', '${WS_S}', '${SEQ}', '${CONTACT_S}');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, enrollment_id, channel, body, status,
                                scheduled_for, sent_at, provider_message_id, recipient_address, attempt_count) VALUES
      ('${TOUCH_SENT}', '${WS_S}', '${COMPANY}', '${CONTACT_S}', '${ENR}', 'email', 'Hola', 'sent',
       now() - interval '1 day', now() - interval '1 day', 'gmail-1', 'valentina@marca.test', 1),
      ('${TOUCH_PENDING}', '${WS_S}', '${COMPANY}', '${CONTACT_S}', '${ENR}', 'email', 'Sigo', 'scheduled',
       now() + interval '2 days', NULL, NULL, NULL, 0),
      ('${TOUCH_LINKEDIN}', '${WS_S}', '${COMPANY}', '${CONTACT_S}', '${ENR}', 'linkedin', 'Hola por aquí', 'draft',
       now() + interval '3 days', NULL, NULL, NULL, 0),
      ('${TOUCH_PENDING_O}', '${WS_O}', '${COMPANY}', '${CONTACT_O}', NULL, 'email', 'Hola', 'scheduled',
       now() + interval '1 day', NULL, NULL, NULL, 0);
    INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, claimed_at, sent_at)
    VALUES ('${optoutTokenHash(TOKEN)}', '${WS_S}', '${TOUCH_SENT}', '${CONTACT_S}', 'valentina@marca.test',
            now() - interval '1 day', now() - interval '1 day');
  `);
});

after(async () => {
  if (t.kind === 'postgres') {
    await t.admin(`
      DELETE FROM workspace WHERE id IN ('${WS_S}', '${WS_O}');
      DELETE FROM company WHERE id = '${COMPANY}';
      DELETE FROM outbound_optout_link WHERE token_hash = '${optoutTokenHash(TOKEN)}';
      DELETE FROM outbound_optout_event WHERE token_hash = '${optoutTokenHash(TOKEN)}';
      DELETE FROM contact_suppression WHERE email = 'valentina@marca.test';
    `);
  }
  await t.close();
});

async function sinRls<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  return t.db.asWorker(async (tx) => (await tx.query<T>(sql)).rows);
}

function puertas(sesion: readonly string[]): OptoutGates {
  return { withPublicShare: (fn) => t.db.withPublicShare(fn), sessionWorkspaceIds: async () => sesion };
}

async function estados(): Promise<Record<string, string>> {
  const rows = await sinRls<{ id: string; status: string }>(
    `SELECT id, status FROM outbound_touch WHERE id IN ('${TOUCH_SENT}', '${TOUCH_PENDING}', '${TOUCH_LINKEDIN}', '${TOUCH_PENDING_O}')`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

describe('la baja desde el enlace', () => {
  test('el clic de un miembro del workspace que envió se rechaza sin tocar nada', async () => {
    const antes = await estados();
    assert.deepEqual(await checkOptoutLink(puertas([WS_O, WS_S]), TOKEN, SECRET), { status: 'sender' });
    assert.deepEqual(await optoutFromLink(puertas([WS_S]), TOKEN, SECRET), { status: 'sender' });
    assert.deepEqual(await estados(), antes);
    const [c] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_S}'`);
    assert.equal(c?.opted_out, false);
  });

  test('un token con otra firma, o sin correo detrás, no encuentra nada', async () => {
    const ajeno = createOptoutToken({ workspaceId: WS_S, contactId: CONTACT_S }, `${SECRET}-de-otro`);
    assert.deepEqual(await optoutFromLink(puertas([]), ajeno, SECRET), { status: 'not_found' });
    assert.deepEqual(await optoutFromLink(puertas([]), 'basura', SECRET), { status: 'not_found' });
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_SIN_CORREO, SECRET), { status: 'not_found' });
  });

  test('un clic marca a la persona y cancela todo lo pendiente, en todos los workspaces', async () => {
    assert.deepEqual(await checkOptoutLink(puertas([WS_O]), TOKEN, SECRET), { status: 'valid', workspaceId: WS_S });
    // Una sesión de OTRO workspace que también le escribe no es quien envió este correo.
    assert.deepEqual(await optoutFromLink(puertas([WS_O]), TOKEN, SECRET), { status: 'ok', alreadyOptedOut: false });
    assert.deepEqual(await estados(), {
      [TOUCH_SENT]: 'sent',
      [TOUCH_PENDING]: 'canceled',
      [TOUCH_LINKEDIN]: 'canceled',
      [TOUCH_PENDING_O]: 'canceled',
    });
    const fichas = await sinRls<{ id: string; opted_out: boolean }>(
      `SELECT id, opted_out FROM contact WHERE id IN ('${CONTACT_S}', '${CONTACT_O}') ORDER BY id`,
    );
    assert.deepEqual(fichas.map((f) => f.opted_out), [true, true]);
    const [e] = await sinRls<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = '${ENR}'`);
    assert.equal(e?.status, 'opted_out');
    const eventos = await sinRls<{ workspace_id: string }>(
      `SELECT workspace_id FROM outbound_optout_event WHERE token_hash = '${optoutTokenHash(TOKEN)}'`,
    );
    assert.deepEqual(eventos.map((x) => x.workspace_id), [WS_S], 'el clic queda atribuido al workspace que envió');
  });

  test('el segundo clic dice que ya estaba de baja', async () => {
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN, SECRET), { status: 'ok', alreadyOptedOut: true });
  });
});

describe('la política editable', () => {
  test('sin guardar, los valores por defecto; guardar la crea apagada', async () => {
    const antes = await t.db.withWorkspace(WS_O, (tx) => getOutboundPolicy(tx));
    assert.equal(antes.saved, false);
    assert.equal(antes.maxEmailsPerDay, 20);
    assert.equal(antes.llmDailyCapUsd, '5.00');
    const guardada = await t.db.withWorkspace(WS_O, (tx) =>
      saveOutboundPolicy(tx, {
        maxTouchesPerCompany: 5, minDaysBetweenTouches: 4, maxEmailsPerDay: 60, cooldownDaysAfterNo: 90,
        requireHumanReview: false, claimsMustBeSourced: true, warmupDays: 21, postalAddress: '  Calle 93 # 11-26, Bogotá  ',
      }),
    );
    assert.equal(guardada.saved, true);
    assert.equal(guardada.enabled, false);
    assert.equal(guardada.maxEmailsPerDay, 60);
    assert.equal(guardada.postalAddress, 'Calle 93 # 11-26, Bogotá');
    // Otro workspace no la ve.
    assert.equal((await t.db.withWorkspace(WS_S, (tx) => getOutboundPolicy(tx))).saved, false);
  });

  test('encendida, no se puede quitar la dirección postal', async () => {
    await t.db.withWorkspace(WS_O, (tx) => enableOutreach(tx));
    const p = await t.db.withWorkspace(WS_O, (tx) => getOutboundPolicy(tx));
    assert.equal(p.enabled, true);
    await assert.rejects(
      t.db.withWorkspace(WS_O, (tx) => saveOutboundPolicy(tx, { ...p, postalAddress: '   ' })),
      PolicyNeedsAddressError,
    );
  });

  test('los rangos se comprueban antes de la base', async () => {
    const p = await t.db.withWorkspace(WS_O, (tx) => getOutboundPolicy(tx));
    await assert.rejects(t.db.withWorkspace(WS_O, (tx) => saveOutboundPolicy(tx, { ...p, maxEmailsPerDay: 5000 })), RangeError);
  });
});

describe('el correo inválido (0038)', () => {
  test('no se programa un correo a una ficha cuyo correo rebotó; LinkedIn sí', async () => {
    await t.admin(`UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = '550 5.1.1'
                   WHERE id = '${CONTACT_REBOTE}'`);
    await assert.rejects(
      t.db.withWorkspace(WS_S, (tx) =>
        tx.query(`INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
                  VALUES ('${WS_S}', '${COMPANY}', '${CONTACT_REBOTE}', 'email', 'Hola', 'scheduled', now() + interval '1 day')`),
      ),
      /rebotó/,
    );
    await t.db.withWorkspace(WS_S, (tx) =>
      tx.query(`INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
                VALUES ('${WS_S}', '${COMPANY}', '${CONTACT_REBOTE}', 'linkedin', 'Hola', 'scheduled', now() + interval '1 day')`),
    );
  });

  test('cambiar el correo de la ficha borra la marca', async () => {
    await t.db.withWorkspace(WS_S, (tx) => tx.query(`UPDATE contact SET email = 'bien@marca.test' WHERE id = '${CONTACT_REBOTE}'`));
    const [c] = await sinRls<{ email_invalid: boolean; email_invalid_reason: string | null }>(
      `SELECT email_invalid, email_invalid_reason FROM contact WHERE id = '${CONTACT_REBOTE}'`,
    );
    assert.deepEqual(c, { email_invalid: false, email_invalid_reason: null });
  });
});

describe('outbound_bounce', () => {
  test('la web lee los suyos y no escribe', async () => {
    await t.admin(`INSERT INTO outbound_bounce (workspace_id, provider_message_id, kind, reason) VALUES
      ('${WS_S}', 'aviso-1', 'hard', '550 5.1.1'), ('${WS_O}', 'aviso-2', 'soft', 'Buzón lleno')`);
    const mios = await t.db.withWorkspace(WS_S, async (tx) => (await tx.query<{ provider_message_id: string }>(
      'SELECT provider_message_id FROM outbound_bounce')).rows);
    assert.deepEqual(mios.map((r) => r.provider_message_id), ['aviso-1']);
    await assert.rejects(
      t.db.withWorkspace(WS_S, (tx) =>
        tx.query(`INSERT INTO outbound_bounce (workspace_id, provider_message_id, kind, reason) VALUES ('${WS_S}', 'x', 'hard', 'x')`),
      ),
      /permission denied|permiso/,
    );
  });
});
