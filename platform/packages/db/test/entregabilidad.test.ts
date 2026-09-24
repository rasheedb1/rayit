/**
 * VEN-15 · entregabilidad en Postgres embebido.
 *
 *   · la baja desde el enlace, de punta a punta: el token opaco (el hash
 *     manda, sin secreto), lo que la página enseña antes del clic
 *     (public_optout_preview: dirección enmascarada, quién escribe), el
 *     rechazo del clic de quien envió con sesión (sin tocar nada), la baja
 *     en dos tiempos (r3: el primer clic vale para quien envió; un
 *     segundo workspace la lleva a toda la plataforma; el remitente sin
 *     sesión no suprime una ficha compartida para nadie más; r4: una
 *     persona con dos espacios que pulsa sus dos enlaces tampoco); el
 *     motivo de la baja se guarda como código; el segundo clic; un token sin
 *     correo detrás no encuentra nada; y el token del despachador de
 *     VEN-10 (randomBytes(32) en base64url) da de baja igual;
 *   · la política editable: valores por defecto, guardar, el interruptor
 *     con dirección postal, que no se puede quitar la dirección con el
 *     envío encendido, y que solo owner y admin la cambian (r3); sin
 *     identidad la regla falla cerrada salvo con app.auth_disabled (r4);
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
  checkOptoutLink, getOutboundPolicy, isPolicyForbidden, optoutFromLink, PolicyForbiddenError, PolicyNeedsAddressError,
  publicOptoutPreview, readAlertSignalCounts, readSendReadiness, saveOutboundPolicy,
  type OptoutGates,
} from '../src/queries/entregabilidad.ts';
import { disableOutreach, enableOutreach } from '../src/queries/outreach.ts';
import { createDb, type BaseTx } from '../src/client.ts';
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
/** Como lo genera hoy el despachador de VEN-10 (outreach-motor.ts, newOptoutToken), sin pasar por @mc/core. */
const TOKEN_VEN10 = randomBytes(32).toString('base64url');
const CONTACT_GLOBAL = '00000038-0000-4000-8000-0000000000f1';
const TOUCH_GLOBAL_SENT_S = '00000038-0000-4000-8000-0000000070f1';
const TOUCH_GLOBAL_PEND_S = '00000038-0000-4000-8000-0000000070f2';
const TOUCH_GLOBAL_PEND_O = '00000038-0000-4000-8000-0000000070f3';
const TOUCH_GLOBAL_SENT_O = '00000038-0000-4000-8000-0000000070f4';
const TOKEN_GLOBAL_S = createOptoutToken();
const TOKEN_GLOBAL_O = createOptoutToken();
/** r4: una persona (una agencia) dueña de dos espacios que le escriben a la misma marca. */
const WS_AG1 = '00000038-0000-4000-8000-0000000000a8';
const WS_AG2 = '00000038-0000-4000-8000-0000000000a9';
const AGENCIA = '00000038-0000-4000-8000-0000000000d8';
const CONTACT_AG = '00000038-0000-4000-8000-0000000000f8';
const TOUCH_AG1_SENT = '00000038-0000-4000-8000-0000000070e1';
const TOUCH_AG2_SENT = '00000038-0000-4000-8000-0000000070e2';
const TOUCH_AGO_SENT = '00000038-0000-4000-8000-0000000070e3';
const TOUCH_AGO_PEND = '00000038-0000-4000-8000-0000000070e4';
const TOKEN_AG1 = createOptoutToken();
const TOKEN_AG2 = createOptoutToken();
const TOKEN_AGO = createOptoutToken();
const TOKENS = [TOKEN, TOKEN_VEN10, TOKEN_GLOBAL_S, TOKEN_GLOBAL_O, TOKEN_AG1, TOKEN_AG2, TOKEN_AGO];

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
      DELETE FROM workspace WHERE id IN ('${WS_S}', '${WS_O}', '${WS_AG1}', '${WS_AG2}', '00000038-0000-4000-8000-0000000000ea');
      DELETE FROM app_user WHERE id = '${AGENCIA}' OR email LIKE '%@politica.test';
      DELETE FROM company WHERE id = '${COMPANY}';
      DELETE FROM outbound_optout_link WHERE token_hash IN (${TOKENS.map((x) => `'${optoutTokenHash(x)}'`).join(', ')});
      DELETE FROM outbound_optout_event WHERE token_hash IN (${TOKENS.map((x) => `'${optoutTokenHash(x)}'`).join(', ')});
      DELETE FROM contact WHERE id IN ('${CONTACT_GLOBAL}', '${CONTACT_AG}');
      DELETE FROM contact_suppression WHERE email IN ('valentina@marca.test', 'tomas@marca.test', 'prensa@marca.test',
                                                      'agencia@marca.test');
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

  test('un clic sin sesión vale YA para quien envió: su ficha, sus toques y su enrolamiento; los demás creadores siguen', async () => {
    // Sin sesión la base no sabe quién pulsa: puede ser el propio
    // remitente en una ventana privada (r3). Por eso el primer clic no
    // suprime a la persona para los demás.
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN), { status: 'ok', alreadyOptedOut: false, scope: 'workspace' });
    assert.deepEqual(await estados(), {
      [TOUCH_SENT]: 'sent',
      [TOUCH_PENDING]: 'canceled',
      [TOUCH_LINKEDIN]: 'canceled',
      [TOUCH_PENDING_O]: 'scheduled',
    });
    const fichas = await sinRls<{ id: string; opted_out: boolean }>(
      `SELECT id, opted_out FROM contact WHERE id IN ('${CONTACT_S}', '${CONTACT_O}') ORDER BY id`,
    );
    assert.deepEqual(fichas.map((f) => f.opted_out), [true, false], 'la ficha de quien envió, sí; la del otro creador, no');
    const [e] = await sinRls<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = '${ENR}'`);
    assert.equal(e?.status, 'opted_out');
    assert.deepEqual(await sinRls(`SELECT 1 FROM contact_suppression WHERE email = 'valentina@marca.test'`), [], 'nada global');
    const eventos = await sinRls<{ workspace_id: string; scope: string }>(
      `SELECT workspace_id, scope FROM outbound_optout_event WHERE token_hash = '${optoutTokenHash(TOKEN)}'`,
    );
    assert.deepEqual(eventos, [{ workspace_id: WS_S, scope: 'workspace' }], 'el clic queda atribuido al workspace que envió');
  });

  test('el segundo clic dice que ya estaba de baja, y la vista previa también', async () => {
    const previa = await checkOptoutLink(puertas([]), TOKEN);
    assert.equal(previa.status === 'valid' && previa.alreadyOptedOut, true);
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN), { status: 'ok', alreadyOptedOut: true, scope: 'workspace' });
  });

  test('sabotaje (r3): el remitente que pulsa su enlace sin sesión, o con un POST a mano, no suprime a una ficha compartida para nadie más', async () => {
    // Un contacto global (fuente pública, sin dueño) al que le escriben los dos.
    await t.admin(`
      INSERT INTO contact (id, company_id, full_name, email, source, source_url, owner_workspace_id) VALUES
        ('${CONTACT_GLOBAL}', '${COMPANY}', 'Prensa', 'prensa@marca.test', 'public_website', 'https://marca.test/prensa', NULL);
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for, sent_at,
                                  provider_message_id, recipient_address, attempt_count) VALUES
        ('${TOUCH_GLOBAL_SENT_S}', '${WS_S}', '${COMPANY}', '${CONTACT_GLOBAL}', 'email', 'Hola', 'sent',
         now() - interval '1 day', now() - interval '1 day', 'gmail-g1', 'prensa@marca.test', 1),
        ('${TOUCH_GLOBAL_PEND_S}', '${WS_S}', '${COMPANY}', '${CONTACT_GLOBAL}', 'email', 'Sigo', 'scheduled',
         now() + interval '1 day', NULL, NULL, NULL, 0),
        ('${TOUCH_GLOBAL_PEND_O}', '${WS_O}', '${COMPANY}', '${CONTACT_GLOBAL}', 'email', 'Hola', 'scheduled',
         now() + interval '1 day', NULL, NULL, NULL, 0),
        ('${TOUCH_GLOBAL_SENT_O}', '${WS_O}', '${COMPANY}', '${CONTACT_GLOBAL}', 'email', 'Hola desde O', 'sent',
         now() - interval '2 days', now() - interval '2 days', 'gmail-g2', 'prensa@marca.test', 1);
      INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, claimed_at, sent_at)
      VALUES ('${optoutTokenHash(TOKEN_GLOBAL_S)}', '${WS_S}', '${TOUCH_GLOBAL_SENT_S}', '${CONTACT_GLOBAL}', 'prensa@marca.test',
              now() - interval '1 day', now() - interval '1 day'),
             ('${optoutTokenHash(TOKEN_GLOBAL_O)}', '${WS_O}', '${TOUCH_GLOBAL_SENT_O}', '${CONTACT_GLOBAL}', 'prensa@marca.test',
              now() - interval '2 days', now() - interval '2 days');
    `);
    // El remitente, sin sesión: su baja es solo suya.
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_GLOBAL_S), { status: 'ok', alreadyOptedOut: false, scope: 'workspace' });
    const toquesG = async () =>
      Object.fromEntries(
        (await sinRls<{ id: string; status: string }>(
          `SELECT id, status FROM outbound_touch WHERE id IN ('${TOUCH_GLOBAL_PEND_S}', '${TOUCH_GLOBAL_PEND_O}')`,
        )).map((r) => [r.id, r.status]),
      );
    assert.deepEqual(await toquesG(), { [TOUCH_GLOBAL_PEND_S]: 'canceled', [TOUCH_GLOBAL_PEND_O]: 'scheduled' });
    const [g] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_GLOBAL}'`);
    assert.equal(g?.opted_out, false, 'la ficha compartida no se marca por un solo remitente');
    assert.deepEqual(await sinRls(`SELECT 1 FROM contact_suppression WHERE email = 'prensa@marca.test'`), []);

    // El workspace que envió ya no le puede programar nada (ningún canal); el otro, sí.
    const nuevo = (ws: string, canal: string) =>
      t.db.withWorkspace(ws, (tx) =>
        tx.query(`INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
                  VALUES ($1, $2, $3, $4, 'Otra vez', 'scheduled', now() + interval '3 days')`, [ws, COMPANY, CONTACT_GLOBAL, canal]),
      );
    await assert.rejects(nuevo(WS_S, 'email'), /pidió no recibir más mensajes de este espacio/);
    await assert.rejects(nuevo(WS_S, 'linkedin'), /pidió no recibir más mensajes de este espacio/);
    await nuevo(WS_O, 'email');

    // Un segundo creador que también le escribió confirma: ahora sí, para toda la plataforma.
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_GLOBAL_O), { status: 'ok', alreadyOptedOut: false, scope: 'global' });
    assert.equal((await toquesG())[TOUCH_GLOBAL_PEND_O], 'canceled');
    const [g2] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_GLOBAL}'`);
    assert.equal(g2?.opted_out, true);
    assert.equal((await sinRls(`SELECT 1 FROM contact_suppression WHERE email = 'prensa@marca.test'`)).length, 1);
  });

  test('sabotaje (r4): una persona dueña de dos espacios pulsa sus dos enlaces y la baja sigue siendo de esos espacios', async () => {
    // Una agencia (o una creadora con dos marcas personales) escribe a la
    // misma dirección desde WS_AG1 y WS_AG2, y es owner de los dos. Sus dos
    // clics sin sesión no son «dos creadores distintos».
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES
        ('${WS_AG1}', 'agencia-uno', 'Agencia · Uno', 'America/Bogota'),
        ('${WS_AG2}', 'agencia-dos', 'Agencia · Dos', 'America/Bogota');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_AG1}', '${COMPANY}'), ('${WS_AG2}', '${COMPANY}');
      INSERT INTO app_user (id, email, name) VALUES ('${AGENCIA}', 'duena@agencia.test', 'Agencia');
      INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS_AG1}', '${AGENCIA}', 'owner'), ('${WS_AG2}', '${AGENCIA}', 'owner');
      INSERT INTO contact (id, company_id, full_name, email, source, source_url, owner_workspace_id) VALUES
        ('${CONTACT_AG}', '${COMPANY}', 'Compras', 'agencia@marca.test', 'public_website', 'https://marca.test/compras', NULL);
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for, sent_at,
                                  provider_message_id, recipient_address, attempt_count) VALUES
        ('${TOUCH_AG1_SENT}', '${WS_AG1}', '${COMPANY}', '${CONTACT_AG}', 'email', 'Hola', 'sent',
         now() - interval '1 day', now() - interval '1 day', 'gmail-a1', 'agencia@marca.test', 1),
        ('${TOUCH_AG2_SENT}', '${WS_AG2}', '${COMPANY}', '${CONTACT_AG}', 'email', 'Hola', 'sent',
         now() - interval '1 day', now() - interval '1 day', 'gmail-a2', 'agencia@marca.test', 1),
        ('${TOUCH_AGO_SENT}', '${WS_O}', '${COMPANY}', '${CONTACT_AG}', 'email', 'Hola desde O', 'sent',
         now() - interval '2 days', now() - interval '2 days', 'gmail-a3', 'agencia@marca.test', 1),
        ('${TOUCH_AGO_PEND}', '${WS_O}', '${COMPANY}', '${CONTACT_AG}', 'email', 'Sigo desde O', 'scheduled',
         now() + interval '1 day', NULL, NULL, NULL, 0);
      INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, recipient_address, claimed_at, sent_at)
      VALUES ('${optoutTokenHash(TOKEN_AG1)}', '${WS_AG1}', '${TOUCH_AG1_SENT}', '${CONTACT_AG}', 'agencia@marca.test',
              now() - interval '1 day', now() - interval '1 day'),
             ('${optoutTokenHash(TOKEN_AG2)}', '${WS_AG2}', '${TOUCH_AG2_SENT}', '${CONTACT_AG}', 'agencia@marca.test',
              now() - interval '1 day', now() - interval '1 day'),
             ('${optoutTokenHash(TOKEN_AGO)}', '${WS_O}', '${TOUCH_AGO_SENT}', '${CONTACT_AG}', 'agencia@marca.test',
              now() - interval '2 days', now() - interval '2 days');
    `);
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_AG1), { status: 'ok', alreadyOptedOut: false, scope: 'workspace' });
    assert.deepEqual(
      await optoutFromLink(puertas([]), TOKEN_AG2),
      { status: 'ok', alreadyOptedOut: false, scope: 'workspace' },
      'el segundo espacio comparte dueña con el primero: no confirma nada',
    );
    assert.deepEqual(await sinRls(`SELECT 1 FROM contact_suppression WHERE email = 'agencia@marca.test'`), []);
    const [pend] = await sinRls<{ status: string }>(`SELECT status FROM outbound_touch WHERE id = '${TOUCH_AGO_PEND}'`);
    assert.equal(pend?.status, 'scheduled', 'el otro creador le sigue escribiendo');
    const [ficha] = await sinRls<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '${CONTACT_AG}'`);
    assert.equal(ficha?.opted_out, false);

    // Un creador de OTRAS personas (WS_O) sí confirma, y la baja pasa a toda la plataforma.
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_AGO), { status: 'ok', alreadyOptedOut: false, scope: 'global' });
    const [pend2] = await sinRls<{ status: string }>(`SELECT status FROM outbound_touch WHERE id = '${TOUCH_AGO_PEND}'`);
    assert.equal(pend2?.status, 'canceled');
    assert.equal((await sinRls(`SELECT 1 FROM contact_suppression WHERE email = 'agencia@marca.test'`)).length, 1);

    // Y la política que abre esas membresías no sobrevive a la llamada.
    await t.db.withPublicShare(async (tx) => {
      const { rows } = await tx.query('SELECT 1 FROM membership');
      assert.equal(rows.length, 0);
    });
  });

  test('el motivo de la baja se guarda como código, no como una frase en un idioma (r4)', async () => {
    const [c] = await sinRls<{ opted_out_reason: string | null }>(`SELECT opted_out_reason FROM contact WHERE id = '${CONTACT_S}'`);
    assert.equal(c?.opted_out_reason, 'unsubscribe_link');
  });

  test('el token del despachador de VEN-10, sin firma ni puntos, da de baja igual', async () => {
    assert.deepEqual(await optoutFromLink(puertas([]), TOKEN_VEN10), { status: 'ok', alreadyOptedOut: false, scope: 'workspace' });
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

  describe('solo quien administra el espacio (0038 §7, r3)', () => {
    const DUENA = '00000038-0000-4000-8000-0000000000d1';
    const ADMIN = '00000038-0000-4000-8000-0000000000d2';
    const LECTORA = '00000038-0000-4000-8000-0000000000d3';
    const CLIENTE = '00000038-0000-4000-8000-0000000000d4';
    const MIEMBRO = '00000038-0000-4000-8000-0000000000d5';
    const como = <T>(userId: string, fn: Parameters<typeof t.db.withWorkspace<T>>[1]) => t.db.withWorkspace(WS_O, fn, { userId });

    before(async () => {
      await t.admin(`
        INSERT INTO app_user (id, email, name) VALUES
          ('${DUENA}', 'duena@politica.test', 'Dueña'), ('${ADMIN}', 'admin@politica.test', 'Admin'),
          ('${LECTORA}', 'lectora@politica.test', 'Lectora'), ('${CLIENTE}', 'cliente@politica.test', 'Cliente'),
          ('${MIEMBRO}', 'miembro@politica.test', 'Miembro');
        INSERT INTO membership (workspace_id, user_id, role) VALUES
          ('${WS_O}', '${DUENA}', 'owner'), ('${WS_O}', '${ADMIN}', 'admin'), ('${WS_O}', '${LECTORA}', 'viewer'),
          ('${WS_O}', '${CLIENTE}', 'client'), ('${WS_O}', '${MIEMBRO}', 'member');
      `);
    });

    test("'viewer', 'client' y 'member' no guardan la política, ni encienden, ni apagan el envío", async () => {
      const p = await como(DUENA, (tx) => getOutboundPolicy(tx));
      for (const quien of [LECTORA, CLIENTE, MIEMBRO]) {
        await assert.rejects(como(quien, (tx) => saveOutboundPolicy(tx, { ...p, maxEmailsPerDay: 2000 })), PolicyForbiddenError);
        await assert.rejects(como(quien, (tx) => disableOutreach(tx, 'yo')), (e: unknown) => isPolicyForbidden(e));
        await assert.rejects(como(quien, (tx) => enableOutreach(tx)), (e: unknown) => isPolicyForbidden(e));
        // Leerla, sí: la pantalla la enseña a todos.
        assert.equal((await como(quien, (tx) => getOutboundPolicy(tx))).maxEmailsPerDay, p.maxEmailsPerDay);
      }
      assert.notEqual((await como(DUENA, (tx) => getOutboundPolicy(tx))).maxEmailsPerDay, 2000);
    });

    test('sin identidad la regla falla cerrada: sin la bandera app.auth_disabled, 42501 (r4)', async () => {
      const p = await t.db.withWorkspace(WS_O, (tx) => getOutboundPolicy(tx));
      const sinBandera = <T>(fn: Parameters<typeof t.db.withWorkspace<T>>[1]) =>
        t.db.withWorkspace(WS_O, async (tx) => {
          // Como una ruta con Supabase Auth configurado que abre withWorkspace sin identidad.
          await tx.query("SELECT set_config('app.auth_disabled', '', true)");
          return fn(tx);
        });
      await assert.rejects(sinBandera((tx) => saveOutboundPolicy(tx, { ...p, maxEmailsPerDay: 1999 })), PolicyForbiddenError);
      await assert.rejects(sinBandera((tx) => disableOutreach(tx, 'cron')), (e: unknown) => isPolicyForbidden(e));
      await assert.rejects(
        sinBandera((tx) => tx.query(`UPDATE outbound_policy SET enabled = true WHERE workspace_id = '${WS_O}'`)),
        (e: unknown) => (e as { code?: string }).code === '42501',
      );
      // Con la bandera (las pruebas, la web sin Supabase Auth) sí, como antes.
      const flag = await t.db.withWorkspace(WS_O, async (tx) =>
        (await tx.query<{ v: string }>("SELECT current_setting('app.auth_disabled', true) AS v")).rows[0]?.v);
      assert.equal(flag, 'on');
    });

    test('el cliente fija app.auth_disabled solo si se le pide (DbOptions.authDisabled)', async () => {
      const consultas = async (opts: { authDisabled?: boolean }) => {
        const vistas: string[] = [];
        const raw = {
          db: {},
          query: async (text: string) => {
            vistas.push(text);
            return { rows: [] };
          },
        } as unknown as BaseTx;
        const db = createDb({ run: (fn) => fn(raw), close: async () => undefined }, opts);
        await db.withWorkspace(WS_O, async () => undefined);
        return vistas.filter((q) => q.includes('app.auth_disabled'));
      };
      assert.deepEqual(await consultas({}), [], 'por defecto no: sin identidad, la regla dice que no');
      assert.equal((await consultas({ authDisabled: true })).length, 1);
    });

    test("'owner' y 'admin' sí", async () => {
      const p = await como(DUENA, (tx) => getOutboundPolicy(tx));
      await como(ADMIN, (tx) => saveOutboundPolicy(tx, { ...p, maxEmailsPerDay: 80 }));
      await como(ADMIN, (tx) => disableOutreach(tx, 'revisión'));
      await como(DUENA, (tx) => enableOutreach(tx));
      const q = await como(DUENA, (tx) => getOutboundPolicy(tx));
      assert.equal(q.maxEmailsPerDay, 80);
      assert.equal(q.enabled, true);
    });

    test('lo que el envío necesita saber antes de encender: cuentas conectadas, caídas y lo aprobado para hoy', async () => {
      await t.admin(`
        INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, display_name, status,
                                              last_error, last_error_at) VALUES
          ('${WS_O}', 'email', 'gmail_oauth', 'otro@creador.test', NULL, 'connected', NULL, NULL),
          ('${WS_O}', 'linkedin', 'unipile', 'unipile-otro', 'Otro creador (LinkedIn)', 'needs_reconnect',
           'La sesión expiró.', now() - interval '1 hour');
      `);
      const r = await t.db.withWorkspace(WS_O, (tx) => readSendReadiness(tx));
      assert.equal(r.connectedAccounts, 1);
      assert.deepEqual(r.downAccounts.map((a) => [a.channel, a.name, a.status, a.lastError]), [
        ['linkedin', 'Otro creador (LinkedIn)', 'needs_reconnect', 'La sesión expiró.'],
      ]);
      // TOUCH_PENDING_O está programado para mañana: hoy no sale nada.
      assert.equal(r.approvedDueToday, 0);
      // Y otro workspace no ve estas cuentas.
      assert.equal((await t.db.withWorkspace(WS_S, (tx) => readSendReadiness(tx))).downAccounts.length, 0);
    });
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

  test('la web no mueve el cursor de rebotes de una cuenta: esconder avisos no se puede (0038 §6)', async () => {
    await t.admin(`INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
                   VALUES ('${WS_S}', 'email', 'gmail_oauth', 'cursor@creador.test', 'connected')`);
    await assert.rejects(
      t.db.withWorkspace(WS_S, (tx) =>
        tx.query(`UPDATE outreach_channel_account SET bounces_read_at = now() + interval '1 year'
                   WHERE provider_account_id = 'cursor@creador.test'`),
      ),
      /cursor de rebotes/,
    );
    // El worker sí.
    await t.db.asWorker((tx) =>
      tx.query(`UPDATE outreach_channel_account SET bounces_read_at = now() WHERE provider_account_id = 'cursor@creador.test'`),
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
    assert.deepEqual(await optoutFromLink(puertas([]), r.token), { status: 'ok', alreadyOptedOut: false, scope: 'workspace' });
  });
});
