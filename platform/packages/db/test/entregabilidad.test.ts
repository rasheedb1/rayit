/**
 * VEN-15 · entregabilidad en Postgres embebido.
 *
 *   · la baja desde el enlace, de punta a punta: el token opaco (el hash
 *     manda, sin secreto), lo que la página enseña antes del clic
 *     (public_optout_preview: dirección enmascarada, quién escribe), el
 *     rechazo del clic de quien envió (sin tocar nada), la ficha marcada
 *     y todo lo pendiente cancelado, en este workspace y en los demás que
 *     le escriben a la misma dirección; el segundo clic; un token sin
 *     correo detrás no encuentra nada; y el token del despachador de
 *     VEN-10 (randomBytes(32) en base64url) da de baja igual;
 *   · la política editable: valores por defecto, guardar, el interruptor
 *     con dirección postal, y que no se puede quitar la dirección con el
 *     envío encendido;
 *   · contact.email_invalid (0038): no se programa un correo a un correo
 *     que rebotó, los otros canales siguen, y cambiar el correo borra la
 *     marca y también contact.bounced;
 *   · outbound_bounce: la web la lee aislada por workspace y no la escribe.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOptoutToken, optoutTokenHash } from '@mc/core/outreach/deliverability';
import {
  checkOptoutLink, getOutboundPolicy, optoutFromLink, PolicyNeedsAddressError, publicOptoutPreview, readAlertSignalCounts,
  saveOutboundPolicy,
  type OptoutGates,
} from '../src/queries/entregabilidad.ts';
import { enableOutreach } from '../src/queries/outreach.ts';
import { crearEnlaceDeDemo, esBaseLocal } from '../scripts/demo-enlace-baja.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const WS_S = '00000038-0000-4000-8000-00000000000a';
const WS_O = '00000038-0000-4000-8000-00000000000b';
const COMPANY = '00000038-0000-4000-8000-0000000000c1';
const CONTACT_S = '00000038-0000-4000-8000-0000000000a1';
const CONTACT_O = '00000038-0000-4000-8000-0000000000b1';
const CONTACT_REBOTE = '00000038-0000-4000-8000-0000000000a2';
const CONTACT_V10 = '00000038-0000-4000-8000-0000000000a3';
const TOUCH_SENT = '00000038-0000-4000-8000-0000000070a1';
const TOUCH_PENDING = '00000038-0000-4000-8000-0000000070a2';
const TOUCH_LINKEDIN = '00000038-0000-4000-8000-0000000070a3';
const TOUCH_PENDING_O = '00000038-0000-4000-8000-0000000070b1';
const TOUCH_V10_SENT = '00000038-0000-4000-8000-0000000070c1';
const TOUCH_V10_PENDING = '00000038-0000-4000-8000-0000000070c2';
const SEQ = '00000038-0000-4000-8000-0000000005a1';
const ENR = '00000038-0000-4000-8000-00000000e0a1';

const TOKEN = createOptoutToken();
/** Un token con la forma de siempre, pero ningún correo salió con él. */
const TOKEN_SIN_CORREO = createOptoutToken();
/** Como lo generaba el despachador de VEN-10 en su ronda 2 (newOptoutToken), sin pasar por @mc/core: un enlace de entonces sigue valiendo. */
const TOKEN_VEN10 = randomBytes(32).toString('base64url');

let t: TestDb;

before(async () => {
  // Ningún secreto en el entorno: la baja no depende de él (hallazgo r1).
  delete process.env.OUTREACH_OPTOUT_SECRET;
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS_S}', 'baja-envia', 'Laura · Cocina fácil', 'America/Bogota'),
      ('${WS_O}', 'baja-otro', 'Otro creador', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY}', 'Marca de la baja', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_S}', '${COMPANY}'), ('${WS_O}', '${COMPANY}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${CONTACT_S}', '${COMPANY}', 'Valentina', 'Valentina@marca.test', 'user_provided', '${WS_S}'),
      ('${CONTACT_O}', '${COMPANY}', 'Valentina (O)', 'valentina@marca.test', 'user_provided', '${WS_O}'),
      ('${CONTACT_REBOTE}', '${COMPANY}', 'Rebote', 'no-existe@marca.test', 'user_provided', '${WS_S}'),
      ('${CONTACT_V10}', '${COMPANY}', 'Tomás', 'tomas@marca.test', 'user_provided', '${WS_S}');
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
       now() + interval '1 day', NULL, NULL, NULL, 0),
      ('${TOUCH_V10_SENT}', '${WS_S}', '${COMPANY}', '${CONTACT_V10}', NULL, 'email', 'Hola', 'sent',
       now() - interval '2 days', now() - interval '2 days', 'gmail-2', 'tomas@marca.test', 1),
      ('${TOUCH_V10_PENDING}', '${WS_S}', '${COMPANY}', '${CONTACT_V10}', NULL, 'email', 'Sigo', 'scheduled',
       now() + interval '1 day', NULL, NULL, NULL, 0);
    INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, claimed_at, sent_at)
    VALUES ('${optoutTokenHash(TOKEN)}', '${WS_S}', '${TOUCH_SENT}', '${CONTACT_S}', 'valentina@marca.test',
            now() - interval '1 day', now() - interval '1 day'),
           ('${optoutTokenHash(TOKEN_VEN10)}', '${WS_S}', '${TOUCH_V10_SENT}', '${CONTACT_V10}', 'tomas@marca.test',
            now() - interval '2 days', now() - interval '2 days');
  `);
});

after(async () => {
  if (t.kind === 'postgres') {
    await t.admin(`
      DELETE FROM workspace WHERE id IN ('${WS_S}', '${WS_O}', '00000038-0000-4000-8000-0000000000ea');
      DELETE FROM company WHERE id = '${COMPANY}';
      DELETE FROM outbound_optout_link WHERE token_hash IN ('${optoutTokenHash(TOKEN)}', '${optoutTokenHash(TOKEN_VEN10)}');
      DELETE FROM outbound_optout_event WHERE token_hash IN ('${optoutTokenHash(TOKEN)}', '${optoutTokenHash(TOKEN_VEN10)}');
      DELETE FROM contact_suppression WHERE email IN ('valentina@marca.test', 'tomas@marca.test');
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
  test('antes del clic: la dirección enmascarada y quién escribe, sin escribir nada', async () => {
    const antes = await estados();
    assert.deepEqual(await checkOptoutLink(puertas([]), TOKEN), {
      status: 'valid',
      maskedAddress: 'v•••@marca.test',
      senderName: 'Laura · Cocina fácil',
      alreadyOptedOut: false,
    });
    assert.deepEqual(await estados(), antes);
    const eventos = await sinRls(`SELECT 1 FROM outbound_optout_event WHERE token_hash = '${optoutTokenHash(TOKEN)}'`);
    assert.equal(eventos.length, 0, 'mirar el enlace no es darse de baja');
  });

  test('la vista previa no deja ningún parámetro abierto en la transacción', async () => {
    await t.db.withPublicShare(async (tx) => {
      await publicOptoutPreview(tx, TOKEN, []);
      const { rows } = await tx.query<{ w: string | null; h: string | null }>(
        `SELECT current_setting('app.public_optout_workspace', true) AS w, current_setting('app.public_optout', true) AS h`,
      );
      assert.ok(!rows[0]?.w && !rows[0]?.h);
    });
  });

  test('el clic de un miembro del workspace que envió se rechaza sin tocar nada', async () => {
    const antes = await estados();
    assert.deepEqual(await checkOptoutLink(puertas([WS_O, WS_S]), TOKEN), { status: 'sender' });
    assert.deepEqual(await optoutFromLink(puertas([WS_S]), TOKEN), { status: 'sender' });
    assert.deepEqual(await estados(), antes);
    const [c] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_S}'`);
    assert.equal(c?.opted_out, false);
  });

  test('un token sin correo detrás, o sin forma de token, no encuentra nada', async () => {
    assert.deepEqual(await optoutFromLink(puertas([]), 'basura'), { status: 'not_found' });
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_SIN_CORREO), { status: 'not_found' });
    assert.deepEqual(await optoutFromLink(puertas([]), "x' OR 1=1 --xxxxxxxxxxxx"), { status: 'not_found' });
  });

  test('un clic marca a la persona y cancela todo lo pendiente, en todos los workspaces', async () => {
    // Una sesión de OTRO workspace que también le escribe no es quien envió este correo.
    assert.deepEqual(await optoutFromLink(puertas([WS_O]), TOKEN), { status: 'ok', alreadyOptedOut: false });
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

  test('el segundo clic dice que ya estaba de baja, y la vista previa también', async () => {
    const previa = await checkOptoutLink(puertas([]), TOKEN);
    assert.equal(previa.status === 'valid' && previa.alreadyOptedOut, true);
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN), { status: 'ok', alreadyOptedOut: true });
  });

  test('el token del despachador de VEN-10, sin firma ni puntos, da de baja igual', async () => {
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_VEN10), { status: 'ok', alreadyOptedOut: false });
    const [c] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_V10}'`);
    assert.equal(c?.opted_out, true);
    const [pend] = await sinRls<{ status: string }>(`SELECT status FROM outbound_touch WHERE id = '${TOUCH_V10_PENDING}'`);
    assert.equal(pend?.status, 'canceled');
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
    // Como lo deja el job outbound.bounces: las dos marcas, la de 0038 y la de 0007.
    await t.admin(`UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = '550 5.1.1',
                          bounced = true
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

  test('cambiar el correo de la ficha borra la marca, también la píldora «Correo rebotado» (bounced)', async () => {
    await t.db.withWorkspace(WS_S, (tx) => tx.query(`UPDATE contact SET email = 'bien@marca.test' WHERE id = '${CONTACT_REBOTE}'`));
    const [c] = await sinRls<{ email_invalid: boolean; email_invalid_reason: string | null; bounced: boolean }>(
      `SELECT email_invalid, email_invalid_reason, bounced FROM contact WHERE id = '${CONTACT_REBOTE}'`,
    );
    assert.deepEqual(c, { email_invalid: false, email_invalid_reason: null, bounced: false });
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

describe('las cifras de las alertas (readAlertSignalCounts)', () => {
  const WS_A = '00000038-0000-4000-8000-0000000000ea';
  const C_A = '00000038-0000-4000-8000-0000000000e1';
  /** Lunes 21 de septiembre de 2026, 14:00 UTC. */
  const LUNES = new Date('2026-09-21T14:00:00Z');

  before(async () => {
    // 20 correos enviados el lunes por la mañana: 3 con rebote blando, 1 con uno duro (y un duro
    // repetido del mismo correo), y un rebote duro de un correo de la semana pasada.
    const enviados = Array.from({ length: 20 }, (_, i) =>
      `('00000038-0000-4000-8000-0000000071${String(i).padStart(2, '0')}', '${WS_A}', '${COMPANY}', '${C_A}', 'email', 'Hola', 'sent',
        '2026-09-21T09:00:00Z', '2026-09-21T09:0${i % 10}:00Z', 'gm-${i}', 'ana@marca.test', 1)`,
    );
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_A}', 'senales', 'Señales', 'America/Bogota');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${COMPANY}');
      INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id)
      VALUES ('${C_A}', '${COMPANY}', 'Ana', 'ana@marca.test', 'user_provided', '${WS_A}');
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for, sent_at,
                                  provider_message_id, recipient_address, attempt_count) VALUES
        ${enviados.join(',\n')},
        ('00000038-0000-4000-8000-000000007199', '${WS_A}', '${COMPANY}', '${C_A}', 'email', 'Vieja', 'sent',
         '2026-09-14T09:00:00Z', '2026-09-14T09:00:00Z', 'gm-viejo', 'ana@marca.test', 1);
      INSERT INTO outbound_bounce (workspace_id, provider_message_id, touch_id, kind, reason) VALUES
        ('${WS_A}', 'b1', '00000038-0000-4000-8000-000000007100', 'soft', 'Buzón lleno'),
        ('${WS_A}', 'b2', '00000038-0000-4000-8000-000000007101', 'soft', 'Buzón lleno'),
        ('${WS_A}', 'b3', '00000038-0000-4000-8000-000000007102', 'blocked', '5.7.1'),
        ('${WS_A}', 'b4', '00000038-0000-4000-8000-000000007103', 'hard', '5.1.1'),
        ('${WS_A}', 'b5', '00000038-0000-4000-8000-000000007103', 'hard', '5.1.1 otra vez'),
        ('${WS_A}', 'b6', '00000038-0000-4000-8000-000000007199', 'hard', '5.1.1 de la semana pasada');
    `);
  });

  test('solo cuentan los rebotes duros de lo que salió en la ventana, una vez por correo', async () => {
    const c = await t.db.asWorker((tx) => readAlertSignalCounts(tx, WS_A, LUNES));
    assert.deepEqual(c, { emailsSent: 20, hardBounces: 1, dueToSend: 0, hardBounceRate: 0.05 });
  });

  test('la pantalla lee lo mismo con el workspace de su transacción', async () => {
    const c = await t.db.withWorkspace(WS_A, (tx) => readAlertSignalCounts(tx, tx.workspaceId, LUNES));
    assert.equal(c.hardBounces, 1);
    assert.equal(c.emailsSent, 20);
  });

  test('un domingo sin nada programado no tiene toques debidos; uno vencido sí, pasada la gracia', async () => {
    const DOMINGO = new Date('2026-09-20T15:00:00Z');
    assert.equal((await t.db.asWorker((tx) => readAlertSignalCounts(tx, WS_A, DOMINGO))).dueToSend, 0);
    await t.admin(`
      INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for) VALUES
        ('${WS_A}', '${COMPANY}', '${C_A}', 'linkedin', 'Vencido', 'scheduled', '2026-09-21T10:00:00Z'),
        ('${WS_A}', '${COMPANY}', '${C_A}', 'linkedin', 'Recién vencido', 'scheduled', '2026-09-21T13:30:00Z'),
        ('${WS_A}', '${COMPANY}', '${C_A}', 'linkedin', 'Para mañana', 'scheduled', '2026-09-22T10:00:00Z');
    `);
    assert.equal((await t.db.asWorker((tx) => readAlertSignalCounts(tx, WS_A, LUNES))).dueToSend, 1);
  });

  test('sin envíos no hay tasa', async () => {
    const c = await t.db.asWorker((tx) => readAlertSignalCounts(tx, WS_A, new Date('2026-09-01T00:00:00Z')));
    assert.equal(c.hardBounceRate, null);
  });
});

describe('el enlace de baja de la demo (pnpm --filter @mc/db demo:enlace-baja)', () => {
  test('se niega con Supabase o cualquier base remota', () => {
    assert.equal(esBaseLocal('postgres://mc:mc@localhost:5432/oncue'), true);
    assert.equal(esBaseLocal('postgresql://mc@127.0.0.1:55437/oncue'), true);
    assert.equal(esBaseLocal('postgres://mc_app.x:y@aws-0-ca-central-1.pooler.supabase.com:6543/postgres'), false);
    assert.equal(esBaseLocal('postgres://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres'), false);
    assert.equal(esBaseLocal('postgres://u:p@mi-servidor.example.com/oncue'), false);
    assert.equal(esBaseLocal('no es una url'), false);
  });

  test('fabrica un enlace que se puede pulsar: la página lo reconoce y el clic da de baja', async () => {
    const r = await t.db.asWorker((tx) => crearEnlaceDeDemo(tx, 'http://localhost:3100/'));
    assert.ok(r.ok);
    assert.equal(r.url, `http://localhost:3100/baja/${r.token}`);
    const previa = await checkOptoutLink(puertas([]), r.token);
    assert.equal(previa.status, 'valid');
    assert.deepEqual(await optoutFromLink(puertas([]), r.token), { status: 'ok', alreadyOptedOut: false });
  });
});
