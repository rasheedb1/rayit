/**
 * VEN-7 · lo que el brief no acepta tampoco se escribe.
 *
 * La pantalla del brief promete que «las cadencias no les escriben». Aquí
 * se comprueba en las dos puertas por las que un mensaje llega a una
 * marca:
 *   · enrollContacts no inscribe una ficha de una marca que el brief
 *     activo excluye, por nombre o por categoría (brief_excluded);
 *   · el reclamo del despachador cancela lo que ya estaba en la cola
 *     cuando el brief cambió (canceledBriefExcluded), con el brief del
 *     workspace del toque: el de otro espacio no cuenta;
 *   · con dos creadores en el espacio, manda el brief del creador del
 *     negocio: lo que uno no acepta, el otro puede aceptarlo;
 *   · y si el creador del negocio no tiene brief propio, lo que excluyen
 *     todos los activos del espacio (la agencia de la ronda 2).
 *
 * Ids nuevos en cada corrida: contra un Postgres que se queda, la prueba
 * se puede repetir.
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import { createSequenceFromTemplate, setSequenceStatus } from '../src/queries/cadencias/index.ts';
import { claimDueTouches } from '../src/queries/outreach.ts';
import { enrollContacts } from '../src/queries/outreach/enroll.ts';
import { saveBrief } from '../src/queries/brief.ts';
import { loadGenerationContext } from '../src/queries/outreach/generation-context.ts';
import { generationInputFrom } from '../src/queries/outreach/generation-mapping.ts';
import { buildGenerationPrompt, loadPrompt } from '@mc/core/outreach/generate';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const WS = randomUUID();
const WS_OTRO = randomUUID();
const CREADORA = randomUUID();
const CREADORA_OTRA = randomUUID();
const CO_CAFE = randomUUID();
const CO_LICOR = randomUUID();
const SOFIA = randomUUID();
const PEDRO = randomUUID();
const GMAIL = randomUUID();
const T_CAFE = randomUUID();
const T_LICOR = randomUUID();
/** Un miércoles a mediodía en Bogotá: dentro de la ventana laboral. */
const CLOCK = new Date('2026-09-23T12:00:00-05:00');

let t: TestDb;
const enWs = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS, fn);

before(async () => {
  t = await openTestDb({ seeds: false });
  const slug = `brief-${WS.slice(0, 8)}`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS}', '${slug}', 'Brief y cadencias', 'America/Bogota'),
      ('${WS_OTRO}', '${slug}-otro', 'Otro espacio', 'America/Bogota');
    INSERT INTO creator_profile (id, workspace_id, display_name, country) VALUES
      ('${CREADORA}', '${WS}', 'Creadora', 'CO'), ('${CREADORA_OTRA}', '${WS_OTRO}', 'Otra creadora', 'CO');
    INSERT INTO company (id, name, industry, owner_workspace_id) VALUES
      ('${CO_CAFE}', 'Café Montaña', 'alimentos', '${WS}'),
      ('${CO_LICOR}', 'Licores del Sur', 'Alcohol', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${CO_CAFE}'), ('${WS}', '${CO_LICOR}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${SOFIA}', '${CO_CAFE}', '${WS}', 'Sofía Cárdenas', 'sofia.${slug}@cafe.test', 'user_provided'),
      ('${PEDRO}', '${CO_LICOR}', '${WS}', 'Pedro Ruiz', 'pedro.${slug}@licores.test', 'user_provided');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_touches_per_company, min_days_between_touches)
    VALUES ('${WS}', true, 'Calle 93 # 11-26, Bogotá', false, 10, 0);
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:${slug}', '${WS}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status,
                                          daily_cap, weekly_cap, secret_ref)
    VALUES ('${GMAIL}', '${WS}', 'email', 'gmail_oauth', '${slug}@gmail.test', 'Creadora', 'connected', 40, 200, 'enc:gmail:${slug}');
    -- El brief de ESTE espacio no acepta alcohol. El del otro no acepta alimentos: no debe tocar a este.
    INSERT INTO outbound_brief (workspace_id, creator_id, title, excluded_categories, status) VALUES
      ('${WS}', '${CREADORA}', 'Sin alcohol', '{alcohol}', 'active'),
      ('${WS_OTRO}', '${CREADORA_OTRA}', 'Sin alimentos', '{alimentos}', 'active');
  `);
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

test('enrolar: la ficha de una marca de categoría excluida no entra (brief_excluded); la otra sí', async () => {
  const id = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enWs((tx) => setSequenceStatus(tx, id, 'active'));
  const r = await enWs((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [SOFIA, PEDRO], now: CLOCK }));
  assert.deepEqual(r.skipped, [{ contactId: PEDRO, reason: 'brief_excluded' }]);
  assert.deepEqual(r.enrolled.map((e) => e.contactId), [SOFIA], 'el brief del otro espacio (sin alimentos) no cuenta aquí');
  const { rows } = await enWs((tx) =>
    tx.query<{ n: number }>('SELECT count(*)::int AS n FROM outbound_touch WHERE contact_id = $1', [PEDRO]),
  );
  assert.equal(rows[0]?.n, 0, 'ni un toque para Licores del Sur');
});

test('enrolar: una marca excluida por nombre tampoco entra, y con el brief en pausa sí', async () => {
  await t.admin(`UPDATE outbound_brief SET excluded_categories = '{}', excluded_companies = '{${CO_LICOR}}' WHERE workspace_id = '${WS}'`);
  const id = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enWs((tx) => setSequenceStatus(tx, id, 'active'));
  const r = await enWs((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [PEDRO], now: CLOCK }));
  assert.deepEqual(r.skipped, [{ contactId: PEDRO, reason: 'brief_excluded' }]);

  await t.admin(`UPDATE outbound_brief SET status = 'paused' WHERE workspace_id = '${WS}'`);
  const enPausa = await enWs((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [PEDRO], now: CLOCK }));
  assert.deepEqual(enPausa.enrolled.map((e) => e.contactId), [PEDRO], 'en pausa, el brief no frena nada');
  await t.admin(`UPDATE outbound_brief SET status = 'active', excluded_categories = '{alcohol}', excluded_companies = '{}' WHERE workspace_id = '${WS}'`);
});

test('el despachador cancela lo que ya estaba en la cola de una marca que el brief no acepta', async () => {
  // Los toques de las pruebas de arriba no cuentan: se cancelan para que el reclamo solo vea estos dos.
  await t.admin(`UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'prueba' WHERE workspace_id = '${WS}'`);
  await t.admin(`
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for) VALUES
      ('${T_CAFE}', '${WS}', '${CO_CAFE}', '${SOFIA}', 'email', 'Hola, Sofía', 'Una idea para Café Montaña.', 'scheduled',
       '${new Date(CLOCK.getTime() - 120_000).toISOString()}'),
      ('${T_LICOR}', '${WS}', '${CO_LICOR}', '${PEDRO}', 'email', 'Hola, Pedro', 'Una idea para Licores del Sur.', 'scheduled',
       '${new Date(CLOCK.getTime() - 60_000).toISOString()}');
  `);
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: WS, limit: 5 }));
  assert.equal(r.canceledBriefExcluded, 1);
  assert.deepEqual(r.claimed.map((x) => x.id), [T_CAFE], 'Café Montaña sale: el brief del otro espacio no la alcanza');
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ status: string; blocked_reason: string | null }>('SELECT status, blocked_reason FROM outbound_touch WHERE id = $1', [T_LICOR]),
  );
  assert.deepEqual({ ...rows[0] }, { status: 'canceled', blocked_reason: 'brief_excluded' });
});

test('con dos creadores cuenta el brief del creador del negocio, al enrolar y en el despachador', async () => {
  // Una segunda creadora del mismo espacio, con su brief activo, que SÍ acepta alcohol.
  const SARA = randomUUID();
  const DEAL_SARA = randomUUID();
  const DEAL_CREADORA = randomUUID();
  const T_SARA = randomUUID();
  await t.admin(`
    UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'prueba' WHERE workspace_id = '${WS}' AND status IN ('scheduled', 'held', 'draft');
    INSERT INTO creator_profile (id, workspace_id, display_name, country) VALUES ('${SARA}', '${WS}', 'Sara', 'CO');
    INSERT INTO outbound_brief (workspace_id, creator_id, title, excluded_categories, status)
    VALUES ('${WS}', '${SARA}', 'Todo menos apuestas', '{apuestas}', 'active');
    INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id) VALUES
      ('${DEAL_SARA}', '${WS}', '${CO_LICOR}', '${SARA}', 'Ron de verano', 'nuevo'),
      ('${DEAL_CREADORA}', '${WS}', '${CO_LICOR}', '${CREADORA}', 'Ron de invierno', 'nuevo');
  `);
  const id = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enWs((tx) => setSequenceStatus(tx, id, 'active'));
  // El negocio de la creadora que no acepta alcohol: Pedro no entra.
  const suyo = await enWs((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [PEDRO], dealId: DEAL_CREADORA, now: CLOCK }));
  assert.deepEqual(suyo.skipped, [{ contactId: PEDRO, reason: 'brief_excluded' }]);
  // El de Sara, que sí lo acepta: entra, en su nombre.
  const deSara = await enWs((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [PEDRO], dealId: DEAL_SARA, now: CLOCK }));
  assert.deepEqual(deSara.enrolled.map((e) => e.contactId), [PEDRO]);

  // En la cola: el toque del negocio de Sara sale; uno suelto (sin negocio)
  // también, porque no TODOS los briefs del espacio excluyen alcohol.
  await t.admin(`
    UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'prueba' WHERE workspace_id = '${WS}' AND status IN ('scheduled', 'held', 'draft');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, deal_id, channel, subject, body, status, scheduled_for) VALUES
      ('${T_SARA}', '${WS}', '${CO_LICOR}', '${PEDRO}', '${DEAL_SARA}', 'email', 'Hola, Pedro', 'Una idea para el ron.', 'scheduled',
       '${new Date(CLOCK.getTime() - 60_000).toISOString()}');
  `);
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: WS, limit: 5 }));
  assert.equal(r.canceledBriefExcluded, 0);
  assert.deepEqual(r.claimed.map((x) => x.id), [T_SARA]);
});

test('en una agencia, el negocio de un creador SIN brief sigue lo que excluyen los briefs del espacio', async () => {
  // La revisión de la ronda 2: agencia con Ana y Beto; el brief se guarda
  // desde la pantalla (saveBrief, con el creador elegido: Ana) y excluye
  // alcohol. El radar oculta la señal de Licores del Sur, pero enrolar con
  // el negocio de Beto inscribía a Pedro. Beto no tiene brief propio: le
  // aplica lo que excluyen los activos del espacio, igual que al radar.
  const AG = randomUUID();
  const ANA = randomUUID();
  const BETO = randomUUID();
  const CO = randomUUID();
  const PEPE = randomUUID();
  const CANAL = randomUUID();
  const DEAL_BETO = randomUUID();
  const T_BETO = randomUUID();
  const slug = `agencia-${AG.slice(0, 8)}`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, timezone) VALUES ('${AG}', '${slug}', 'Agencia', 'agency', 'America/Bogota');
    INSERT INTO creator_profile (id, workspace_id, display_name, country) VALUES
      ('${ANA}', '${AG}', 'Ana', 'CO'), ('${BETO}', '${AG}', 'Beto', 'CO');
    INSERT INTO company (id, name, industry, owner_workspace_id) VALUES ('${CO}', 'Licores del Sur', 'Alcohol', '${AG}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${AG}', '${CO}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${PEPE}', '${CO}', '${AG}', 'Pedro Ruiz', 'pedro.${slug}@licores.test', 'user_provided');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_touches_per_company, min_days_between_touches)
    VALUES ('${AG}', true, 'Calle 93 # 11-26, Bogotá', false, 10, 0);
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:${slug}', '${AG}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status,
                                          daily_cap, weekly_cap, secret_ref)
    VALUES ('${CANAL}', '${AG}', 'email', 'gmail_oauth', '${slug}@gmail.test', 'Agencia', 'connected', 40, 200, 'enc:gmail:${slug}');
    INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
    VALUES ('${DEAL_BETO}', '${AG}', '${CO}', '${BETO}', 'Ron con Beto', 'nuevo');
  `);
  const enAg = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(AG, fn);
  await enAg((tx) =>
    saveBrief(tx, ANA, {
      title: 'Sin alcohol', wantedCategories: [], wantedCountries: [], minBudget: null, currency: 'COP', deliverables: [],
      availabilityFrom: null, availabilityTo: null, excludedCategories: ['alcohol'], excludedCompanyIds: [],
      requiresDisclosure: true, notes: null, active: true,
    }),
  );

  const id = await enAg((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enAg((tx) => setSequenceStatus(tx, id, 'active'));
  const r = await enAg((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [PEPE], dealId: DEAL_BETO, now: CLOCK }));
  assert.deepEqual(r.skipped, [{ contactId: PEPE, reason: 'brief_excluded' }], 'Beto no tiene brief: manda el del espacio');
  assert.deepEqual(r.enrolled, []);

  // Y lo que estaba en la cola con el negocio de Beto se cancela.
  await t.admin(`
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, deal_id, channel, subject, body, status, scheduled_for) VALUES
      ('${T_BETO}', '${AG}', '${CO}', '${PEPE}', '${DEAL_BETO}', 'email', 'Hola, Pedro', 'Una idea para el ron.', 'scheduled',
       '${new Date(CLOCK.getTime() - 60_000).toISOString()}');
  `);
  const cola = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: AG, limit: 5 }));
  assert.equal(cola.canceledBriefExcluded, 1);
  assert.deepEqual(cola.claimed, []);
});

test('VEN-7 r4 · el pitch de la cadencia propone solo los formatos del brief y fechas dentro de su ventana', async () => {
  // Una ficha nueva de Café Montaña (alimentos: el brief la acepta), en una
  // cadencia que lleva el brief de la creadora, con formatos y ventana.
  const LUCIA = randomUUID();
  await t.admin(`
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${LUCIA}', '${CO_CAFE}', '${WS}', 'Lucía Pardo', 'lucia.${WS.slice(0, 8)}@cafe.test', 'user_provided');
    UPDATE outbound_brief
       SET deliverables = '[{"kind": "reel"}, {"kind": "historias", "label": "Historias (3 pantallas)"}]'::jsonb,
           availability_from = '2026-10-01', availability_to = '2026-12-15'
     WHERE workspace_id = '${WS}' AND creator_id = '${CREADORA}';
  `);
  const id = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await t.admin(`
    UPDATE outbound_sequence s SET brief_id = b.id
      FROM outbound_brief b
     WHERE s.id = '${id}' AND b.workspace_id = '${WS}' AND b.creator_id = '${CREADORA}';
  `);
  await enWs((tx) => setSequenceStatus(tx, id, 'active'));
  const r = await enWs((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [LUCIA], now: CLOCK }));
  assert.deepEqual(r.enrolled.map((e) => e.contactId), [LUCIA]);
  const { rows } = await enWs((tx) =>
    tx.query<{ id: string }>(
      `SELECT t.id FROM outbound_touch t JOIN outbound_enrollment e ON e.id = t.enrollment_id
        WHERE e.sequence_id = $1 AND t.contact_id = $2 ORDER BY t.scheduled_for LIMIT 1`,
      [id, LUCIA],
    ),
  );
  const ctx = await t.db.asWorker((tx) => loadGenerationContext(tx, rows[0]!.id));
  assert.deepEqual(ctx.brief?.deliverables, ['reel', 'historia'], 'con el nombre del catálogo');
  assert.deepEqual([ctx.brief?.availabilityFrom, ctx.brief?.availabilityTo], ['2026-10-01', '2026-12-15']);
  const { user } = buildGenerationPrompt({ ...generationInputFrom(ctx), attempt: 1, hint: null }, loadPrompt('generate'));
  assert.ok(user.includes('Formatos que ofrece el creador: reel de Instagram, historias de Instagram. Si propones una colaboración, propón solo estos formatos.'), user);
  assert.ok(user.includes('Disponible para campañas del 2026-10-01 al 2026-12-15'), user);
});
