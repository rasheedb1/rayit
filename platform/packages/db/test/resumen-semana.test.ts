/**
 * RES-3 · «Lo que importa esta semana» contra el Postgres embebido con
 * el seed, como mc_app y sin red.
 *
 * Lo primero que se mira es el seed de la demo (0011): sin tocar nada, el
 * bloque enseña las cinco fuentes, cada una con su enlace. Después se
 * quitan esos avisos y se siembran los de la prueba con la forma EXACTA
 * que dejan sus productores (kind, entity_type, action_url, user_id);
 * que los productores de verdad escriban eso lo prueba, de punta a punta,
 * apps/worker/test/lo-que-importa.test.ts. Aquí van las reglas de la
 * lectura (queries/resumen-semana.ts):
 *
 *   - las fuentes dan su fila, en orden de urgencia, y el video sin
 *     título se nombra por su texto;
 *   - una fila por cosa: el aviso más reciente, y el «Entendido» no
 *     resucita el anterior;
 *   - solo lo que SIGUE siendo cierto hoy;
 *   - «Entendido» es de la persona (0078), se puede deshacer, no toca
 *     read_at, no se da por otro, ni sobre un aviso ajeno ni sobre una
 *     fuente que la persona no ve;
 *   - sin finanzas.factura.ver (los permisos REALES del rol Mánager,
 *     leídos de role_permission) no hay fila de factura;
 *   - el alcance de ACC-6: quien ve solo lo de Laura no ve lo de Sofía,
 *     en ninguna de las cinco ramas;
 *   - con más de MAX_HIGHLIGHTS, `more` lo dice.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { videoName, type Permiso } from '@mc/core';
import type { WorkspaceTx } from '../src/client.ts';
import { getSessionPermissions } from '../src/queries/accesos.ts';
import {
  acknowledgeHighlight,
  compareHighlights,
  listWeeklyHighlights,
  MAX_HIGHLIGHTS,
  unacknowledgeHighlight,
  WEEKLY_SOURCES,
  weeklySourcesFor,
  type WeeklyHighlight,
  type WeeklySource,
} from '../src/queries/resumen-semana.ts';
import { markReminderSent } from '../src/queries/finanzas.ts';
import { openTestDb, POST_D01_REEL_CAFE_ALMA, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import {
  CONEXION_SOFIA, CREATOR_SOFIA, EMPRESA_SOFIA, INVOICE_SOFIA, POST_SOFIA, sembrarAlcance, USER_LAURA, USER_MIEMBRO,
} from './alcance.ts';

/** La cuenta de TikTok de Laura (seed 0002). */
const CONEXION_TIKTOK = '00000002-0000-4000-8000-0000000000c2';
/** La página de Facebook de Laura, que el seed 0011 deja en needs_reauth. */
const CONEXION_FACEBOOK = '00000002-0000-4000-8000-0000000000c4';
/** El LinkedIn de envío de Laura, por reconectar desde el seed 0005. */
const CANAL_LINKEDIN = '00000005-0000-4000-8000-0000000ac002';
/** FV-2026-007, abierta y vencida hace 41 días (seed 0003). */
const FV_007 = '00000003-0000-4000-8000-0000fac26007';
/** Una Mánager sin alcance: ve todo el espacio, pero su rol no tiene Finanzas. */
const USER_MANAGER = '0000000c-0000-4000-8000-0000000000a1';
/** Otro espacio, con su propio aviso. */
const WS_AJENO = '0000000c-0000-4000-8000-000000000051';
/** Un negocio de Sofía, con la acción vencida, para el alcance de la rama deal. */
const DEAL_SOFIA = '0000000c-0000-4000-8000-00000000de51';
/** Una cuenta de envío de Sofía, caída, para el alcance de la rama channel. */
const CANAL_SOFIA = '0000000c-0000-4000-8000-0000000ac051';

const N = (n: string) => `0000000c-0000-4000-8000-00000000${n}`;
const N_CONEXION = N('0c01');
const N_CANAL = N('0c02');
const N_FACTURA_PASO_0 = N('0f00');
const N_FACTURA = N('0f01');
const N_NEGOCIO = N('0d01');
const N_OUTLIER = N('0a01');
const N_BREAKOUT = N('0a02');
const N_AJENO = N('0e01');
const N_SOFIA_CONEXION = N('5c01');
const N_SOFIA_CANAL = N('5c02');
const N_SOFIA_FACTURA = N('5f01');
const N_SOFIA_VIDEO = N('5a01');
const N_SOFIA_NEGOCIO = N('5d01');

let t: TestDb;
/** Lo que enseña el bloque sobre el seed de la demo, antes de tocar nada. */
let semilla: WeeklyHighlight[];
/** Un negocio abierto de Laura con la acción vencida (seed 0002). */
let negocio: { id: string; company_id: string };

const como = <T>(userId: string | null, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> =>
  userId === null ? t.db.withWorkspace(WORKSPACE_LAURA, fn) : t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId });

const leer = (userId: string | null, sources: readonly WeeklySource[] = WEEKLY_SOURCES) =>
  como(userId, (tx) => listWeeklyHighlights(tx, sources));

const lista = async (userId: string | null, sources: readonly WeeklySource[] = WEEKLY_SOURCES) => (await leer(userId, sources)).rows;

const permisosDe = async (userId: string): Promise<ReadonlySet<Permiso>> =>
  new Set((await como(userId, (tx) => getSessionPermissions(tx))) as Permiso[]);

const ids = (filas: readonly WeeklyHighlight[]) => filas.map((f) => f.id);

const entender = (userId: string | null, id: string, sources: readonly WeeklySource[] = WEEKLY_SOURCES) =>
  como(userId, (tx) => acknowledgeHighlight(tx, id, sources));

const deshacer = (userId: string | null, id: string, sources: readonly WeeklySource[] = WEEKLY_SOURCES) =>
  como(userId, (tx) => unacknowledgeHighlight(tx, id, sources));

const gestos = async (id: string) =>
  (await t.db.asWorker((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM notification_ack WHERE notification_id = $1', [id])))
    .rows[0]?.n;

/** INSERT de un aviso como lo deja su productor. */
function aviso(o: {
  id: string; kind: string; severity: string; entityType: string; entityId: string; actionUrl: string;
  userId?: string | null; createdAt?: string; workspaceId?: string;
}): string {
  return `INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
          VALUES ('${o.id}', '${o.workspaceId ?? WORKSPACE_LAURA}', ${o.userId ? `'${o.userId}'` : 'NULL'}, '${o.kind}', '${o.severity}',
                  'Título de ${o.kind}', 'Cuerpo de ${o.kind}', '${o.entityType}', '${o.entityId}', '${o.actionUrl}',
                  ${o.createdAt ?? 'now()'})
          ON CONFLICT (id) DO NOTHING;`;
}

before(async () => {
  t = await openTestDb();
  // El seed de la demo, tal cual: sin persona, como el modo demo.
  semilla = await lista(null);
  // A partir de aquí, solo los avisos de la prueba.
  await t.admin(`DELETE FROM notification WHERE id::text LIKE '00000011-%'`);

  await t.admin(`
    INSERT INTO app_user (id, email, name, locale) VALUES ('${USER_MANAGER}', 'manager.semana@ejemplo.com', 'Mánager', 'es-CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id)
    VALUES ('${WORKSPACE_LAURA}', '${USER_MANAGER}', system_role_id('creator', 'manager')) ON CONFLICT DO NOTHING;
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_AJENO}', 'ajeno-semana', 'Estudio ajeno', 'COP', 'America/Bogota', 'es-CO', 'CO') ON CONFLICT DO NOTHING;
  `);
  const abiertos = await como(USER_LAURA, (tx) =>
    tx.query<{ id: string; company_id: string }>(
      `SELECT id, company_id FROM deal_pipeline
        WHERE due_state = 'vencido' AND NOT is_won AND NOT is_lost AND nullif(btrim(next_action), '') IS NOT NULL
        ORDER BY next_action_due LIMIT 1`,
    ),
  );
  assert.ok(abiertos.rows[0], 'el seed 0002 trae al menos un negocio con la acción vencida');
  negocio = abiertos.rows[0];

  await t.admin(`
    UPDATE social_connection SET status = 'needs_reauth', status_detail = 'TikTok pidió volver a autorizar la cuenta.'
     WHERE id = '${CONEXION_TIKTOK}';
    ${aviso({ id: N_CONEXION, kind: 'connection_error', severity: 'critical', entityType: 'social_connection', entityId: CONEXION_TIKTOK, actionUrl: '/conexiones' })}
    ${aviso({ id: N_FACTURA_PASO_0, kind: 'invoice_overdue', severity: 'info', entityType: 'invoice', entityId: FV_007, actionUrl: `/finanzas/facturas/${FV_007}?recordatorio=2`, createdAt: "now() - interval '41 days'" })}
    ${aviso({ id: N_FACTURA, kind: 'invoice_overdue', severity: 'warning', entityType: 'invoice', entityId: FV_007, actionUrl: `/finanzas/facturas/${FV_007}?recordatorio=4`, createdAt: "now() - interval '20 days'" })}
    ${aviso({ id: N_NEGOCIO, kind: 'deal_overdue', severity: 'warning', entityType: 'deal', entityId: negocio.id, actionUrl: `/ventas/empresas/${negocio.company_id}`, userId: USER_LAURA })}
    ${aviso({ id: N_OUTLIER, kind: 'outlier', severity: 'success', entityType: 'post', entityId: POST_D01_REEL_CAFE_ALMA, actionUrl: '/resumen', createdAt: "now() - interval '3 days'" })}
    ${aviso({ id: N_BREAKOUT, kind: 'breakout', severity: 'success', entityType: 'post', entityId: POST_D01_REEL_CAFE_ALMA, actionUrl: '/resumen', createdAt: "now() - interval '1 day'" })}
    ${aviso({ id: N_AJENO, kind: 'connection_error', severity: 'critical', entityType: 'social_connection', entityId: CONEXION_TIKTOK, actionUrl: '/conexiones', workspaceId: WS_AJENO })}
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t.close();
});

describe('el seed de la demo (0011)', () => {
  test('enseña las cinco fuentes, en orden de urgencia, cada una con su enlace al módulo', () => {
    assert.deepEqual(semilla.map((f) => f.source), ['connection', 'channel', 'invoice', 'deal', 'outlier']);
    const [cuenta, canal, cobro, seguimiento, video] = semilla;
    assert.ok(cuenta?.source === 'connection');
    assert.equal(cuenta.connectionId, CONEXION_FACEBOOK);
    assert.equal(cuenta.status, 'needs_reauth');
    assert.equal(cuenta.actionUrl, '/conexiones');
    assert.ok(canal?.source === 'channel');
    assert.equal(canal.accountId, CANAL_LINKEDIN);
    assert.equal(canal.actionUrl, '/ventas/canales');
    assert.ok(cobro?.source === 'invoice');
    assert.equal(cobro.invoiceId, FV_007);
    assert.equal(cobro.actionUrl, `/finanzas/facturas/${FV_007}?recordatorio=4`);
    assert.ok(seguimiento?.source === 'deal');
    assert.equal(seguimiento.actionUrl, `/ventas/empresas/${seguimiento.companyId}`);
    assert.ok(video?.source === 'outlier');
    assert.ok(video.viewsVsMedian !== null && Number(video.viewsVsMedian) >= 2);
    assert.ok(video.postTitle, 'el video de la demo tiene nombre');
  });
});

describe('las fuentes', () => {
  test('cada una da su fila, una por cosa, en orden de urgencia', async () => {
    const filas = await lista(USER_LAURA);
    assert.deepEqual(filas.map((f) => f.source), ['connection', 'invoice', 'deal', 'outlier']);
    assert.deepEqual(ids(filas), [N_CONEXION, N_FACTURA, N_NEGOCIO, N_BREAKOUT], 'el aviso más reciente de cada cosa');
    for (let i = 1; i < filas.length; i++) assert.ok(compareHighlights(filas[i - 1]!, filas[i]!) < 0);

    const [conexion, factura, trato, video] = filas;
    assert.ok(conexion?.source === 'connection');
    assert.equal(conexion.kind, 'connection_error');
    assert.equal(conexion.status, 'needs_reauth');
    assert.equal(conexion.platformId, 'tiktok');
    assert.equal(conexion.handle, 'laura.cocinafacil');
    assert.equal(conexion.detail, 'TikTok pidió volver a autorizar la cuenta.');
    assert.equal(conexion.actionUrl, '/conexiones');

    assert.ok(factura?.source === 'invoice');
    assert.equal(factura.invoiceNumber, 'FV-2026-007');
    assert.equal(factura.outstanding, '1100000.00');
    assert.equal(factura.currency, 'COP');
    // El seed fija due_on con CURRENT_DATE (UTC) y la mora se cuenta en Bogotá: 40 entre las 0:00 y las 5:00 UTC.
    assert.ok([40, 41].includes(factura.daysOverdue), `mora ${factura.daysOverdue}`);
    assert.equal(factura.actionUrl, `/finanzas/facturas/${FV_007}?recordatorio=4`);

    assert.ok(trato?.source === 'deal');
    assert.equal(trato.dealId, negocio.id);
    assert.equal(trato.companyId, negocio.company_id);
    assert.equal(trato.dueState, 'vencido');
    assert.ok(trato.daysOverdue >= 0);
    assert.ok(trato.nextAction.length > 0);

    assert.ok(video?.source === 'outlier');
    assert.equal(video.tier, 'breakout');
    assert.equal(video.postId, POST_D01_REEL_CAFE_ALMA);
    assert.equal(video.postTitle, 'Cold brew en casa en 3 pasos');
    assert.equal(video.viewsVsMedian, '5.971', 'el múltiplo es el de post_score, no uno recalculado');
    assert.equal(video.ageHoursCut, 720);
  });

  test('un video sin título (Instagram nunca lo trae) se nombra por su texto, como el aviso de CON-6; sin ninguno, null', async () => {
    const { rows } = await t.db.asWorker((tx) =>
      tx.query<{ caption: string }>('SELECT caption FROM post WHERE id = $1', [POST_D01_REEL_CAFE_ALMA]));
    const caption = rows[0]!.caption;
    try {
      await t.admin(`UPDATE post SET title = NULL WHERE id = '${POST_D01_REEL_CAFE_ALMA}'`);
      const video = (await lista(USER_LAURA)).find((f) => f.source === 'outlier');
      assert.ok(video?.source === 'outlier');
      assert.equal(video.postTitle, videoName(null, caption));
      assert.ok(video.postTitle?.startsWith('Cold brew en casa en 3 pasos'));

      await t.admin(`UPDATE post SET title = '   ', caption = NULL WHERE id = '${POST_D01_REEL_CAFE_ALMA}'`);
      const sinNada = (await lista(USER_LAURA)).find((f) => f.source === 'outlier');
      assert.ok(sinNada?.source === 'outlier');
      assert.equal(sinNada.postTitle, null, 'sin título ni texto: null, y la pantalla dice «Tu video de Instagram»');
    } finally {
      await t.admin(`UPDATE post SET title = 'Cold brew en casa en 3 pasos', caption = $$${caption}$$ WHERE id = '${POST_D01_REEL_CAFE_ALMA}'`);
    }
  });

  test('una fuente que no es de la lista no elige SQL: se ignora', async () => {
    const filas = await lista(USER_LAURA, ['invoice', 'nada' as WeeklySource]);
    assert.deepEqual(filas.map((f) => f.source), ['invoice']);
    assert.deepEqual(await leer(USER_LAURA, []), { rows: [], more: false });
  });
});

describe('la cuenta de envío (canales)', () => {
  before(async () => {
    await t.admin(aviso({
      id: N_CANAL, kind: 'connection_error', severity: 'critical', entityType: 'outreach_channel_account', entityId: CANAL_LINKEDIN,
      actionUrl: '/ventas/canales', createdAt: "now() - interval '2 hours'",
    }));
  });

  test('el LinkedIn caído sale como canal, no como cuenta social, y lleva a Canales', async () => {
    const canal = (await lista(USER_LAURA)).find((f) => f.id === N_CANAL);
    assert.ok(canal?.source === 'channel');
    assert.equal(canal.channel, 'linkedin');
    assert.equal(canal.displayName, 'Laura Méndez');
    assert.equal(canal.status, 'needs_reconnect');
    assert.equal(canal.actionUrl, '/ventas/canales');
    assert.ok(!(await lista(USER_LAURA, ['connection'])).some((f) => f.id === N_CANAL), 'la rama de cuentas sociales no la lee');
  });

  test('cuando vuelve (aviso de éxito y la cuenta conectada), sale del bloque', async () => {
    await t.admin(`
      UPDATE outreach_channel_account SET status = 'connected' WHERE id = '${CANAL_LINKEDIN}';
      ${aviso({ id: N('0c03'), kind: 'connection_error', severity: 'success', entityType: 'outreach_channel_account', entityId: CANAL_LINKEDIN, actionUrl: '/ventas/canales' })}
    `);
    assert.ok(!(await lista(USER_LAURA)).some((f) => f.source === 'channel'));
    await t.admin(`
      UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = '${CANAL_LINKEDIN}';
      DELETE FROM notification WHERE id IN ('${N('0c03')}', '${N_CANAL}');
    `);
  });
});

describe('permisos y personas', () => {
  test('sin finanzas.factura.ver (el rol Mánager, leído de la base) no hay fila de factura', async () => {
    const manager = weeklySourcesFor(await permisosDe(USER_MANAGER));
    assert.deepEqual(manager, ['connection', 'channel', 'deal', 'outlier']);
    assert.deepEqual(weeklySourcesFor(await permisosDe(USER_LAURA)), [...WEEKLY_SOURCES], 'la dueña ve las cinco');

    const filas = await lista(USER_MANAGER, manager);
    assert.ok(!filas.some((f) => f.source === 'invoice'));
    assert.ok(!ids(filas).includes(N_FACTURA));
  });

  test('el seguimiento va a su responsable: la Mánager no ve el aviso de Laura; sin persona (demo) se ve', async () => {
    assert.ok(!ids(await lista(USER_MANAGER)).includes(N_NEGOCIO));
    assert.ok(ids(await lista(null)).includes(N_NEGOCIO));
  });

  test('otro espacio no ve nada de este, ni este el aviso del otro', async () => {
    assert.ok(!ids(await lista(USER_LAURA)).includes(N_AJENO));
    const ajeno = await t.db.withWorkspace(WS_AJENO, (tx) => listWeeklyHighlights(tx, WEEKLY_SOURCES));
    assert.deepEqual(ajeno, { rows: [], more: false }, 'la cuenta del aviso ajeno es de otro espacio: RLS no la deja unir');
  });
});

describe('«Entendido» y «Deshacer»', () => {
  test('es de la persona: a Laura se le va la fila y a la Mánager no; read_at no se toca', async () => {
    assert.equal(await entender(USER_LAURA, N_BREAKOUT), true);
    const laura = await lista(USER_LAURA);
    assert.ok(!laura.some((f) => f.source === 'outlier'), 'entender el breakout no resucita el outlier de antes');
    assert.ok(ids(await lista(USER_MANAGER)).includes(N_BREAKOUT));

    const fila = await como(USER_LAURA, (tx) =>
      tx.query<{ read_at: unknown }>('SELECT read_at FROM notification WHERE id = $1', [N_BREAKOUT]));
    assert.equal(fila.rows[0]?.read_at, null);
  });

  test('repetir el clic no escribe otra fila', async () => {
    assert.equal(await entender(USER_LAURA, N_BREAKOUT), true);
    assert.equal(await gestos(N_BREAKOUT), 1);
  });

  test('«Deshacer» la devuelve; repetirlo no escribe nada; entender otra vez la vuelve a quitar. Nada se borra', async () => {
    assert.equal(await deshacer(USER_LAURA, N_BREAKOUT), true);
    assert.ok(ids(await lista(USER_LAURA)).includes(N_BREAKOUT), 'vuelve a la lista de Laura');
    assert.equal(await deshacer(USER_LAURA, N_BREAKOUT), true);
    assert.equal(await gestos(N_BREAKOUT), 2, 'Entendido + Deshacer');
    assert.equal(await entender(USER_LAURA, N_BREAKOUT), true);
    assert.ok(!ids(await lista(USER_LAURA)).includes(N_BREAKOUT));
    assert.equal(await gestos(N_BREAKOUT), 3, 'cada gesto es su fila: vale el último');
  });

  test('deshacer lo que nunca se entendió no escribe nada', async () => {
    assert.equal(await deshacer(USER_MANAGER, N_BREAKOUT), true);
    const propios = await como(USER_MANAGER, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM notification_ack WHERE notification_id = $1 AND user_id = $2', [N_BREAKOUT, USER_MANAGER]));
    assert.equal(propios.rows[0]?.n, 0);
  });

  test('sin persona (demo) también vale, y es solo de la demo', async () => {
    assert.equal(await entender(null, N_CONEXION), true);
    assert.ok(!ids(await lista(null)).includes(N_CONEXION));
    assert.ok(ids(await lista(USER_LAURA)).includes(N_CONEXION));
  });

  test('no vale para un aviso que no es del bloque, de otro espacio, de otra persona o con un id imposible', async () => {
    const conexionAgregada = '00000003-0000-4000-8000-0000ac080002';
    assert.equal(await entender(USER_LAURA, conexionAgregada), false);
    assert.equal(await entender(USER_LAURA, N_AJENO), false);
    assert.equal(await entender(USER_MANAGER, N_NEGOCIO), false);
    assert.equal(await entender(USER_LAURA, 'no-es-un-id'), false);
  });

  test('no vale sobre una fuente que la persona no ve: la Mánager no entiende una factura aunque conozca el id', async () => {
    const manager = weeklySourcesFor(await permisosDe(USER_MANAGER));
    assert.equal(await entender(USER_MANAGER, N_FACTURA, manager), false);
    assert.equal(await deshacer(USER_MANAGER, N_FACTURA, manager), false);
    assert.equal(await entender(USER_LAURA, N_CONEXION, ['channel']), false, 'el mismo kind en otra fuente tampoco: manda la cosa');
    assert.equal(await entender(USER_LAURA, N_CONEXION, []), false);
    assert.equal(await gestos(N_FACTURA), 0);
  });

  test('nadie lo da ni lo deshace por otro, y no se corrige ni se borra', async () => {
    for (const action of ['ack', 'undo']) {
      await assert.rejects(
        como(USER_LAURA, (tx) =>
          tx.query(
            'INSERT INTO notification_ack (workspace_id, notification_id, user_id, action) VALUES (current_workspace_id(), $1, $2, $3)',
            [N_FACTURA, USER_MANAGER, action],
          )),
        /row-level security|política|policy/i,
      );
    }
    await assert.rejects(como(USER_LAURA, (tx) => tx.query('DELETE FROM notification_ack')), /permission denied|permiso/i);
    await assert.rejects(como(USER_LAURA, (tx) => tx.query(`UPDATE notification_ack SET action = 'undo'`)), /permission denied|permiso/i);
  });
});

describe('solo lo que sigue siendo cierto', () => {
  test('el recordatorio ya mandado en Finanzas saca la factura, y no vuelve el del paso anterior', async () => {
    assert.equal(await como(USER_LAURA, (tx) => markReminderSent(tx, N_FACTURA)), true);
    const filas = await lista(USER_LAURA);
    assert.ok(!filas.some((f) => f.source === 'invoice'));
  });

  test('una factura pagada no está vencida aunque su aviso siga sin leer', async () => {
    await t.admin(`UPDATE notification SET read_at = NULL WHERE id = '${N_FACTURA}'`);
    assert.ok(ids(await lista(USER_LAURA)).includes(N_FACTURA));
    await t.admin(`UPDATE invoice SET status = 'paid', paid_amount = total, paid_at = now() WHERE id = '${FV_007}'`);
    assert.ok(!ids(await lista(USER_LAURA)).includes(N_FACTURA));
  });

  test('la cuenta que vuelve a leerse sale del bloque', async () => {
    assert.ok(ids(await lista(USER_LAURA)).includes(N_CONEXION));
    await t.admin(`UPDATE social_connection SET status = 'active', status_detail = NULL WHERE id = '${CONEXION_TIKTOK}'`);
    assert.ok(!ids(await lista(USER_LAURA)).includes(N_CONEXION));
  });

  test('el seguimiento que se movió a la semana que viene ya no vence', async () => {
    assert.ok(ids(await lista(USER_LAURA)).includes(N_NEGOCIO));
    await t.admin(`UPDATE deal SET next_action_due = now() + interval '7 days' WHERE id = '${negocio.id}'`);
    assert.ok(!ids(await lista(USER_LAURA)).includes(N_NEGOCIO));
  });

  test('el aviso de un compromiso anterior no vale para el nuevo, aunque también esté vencido', async () => {
    await t.admin(`UPDATE deal SET next_action_due = now() - interval '1 hour' WHERE id = '${negocio.id}'`);
    await t.admin(`UPDATE notification SET created_at = now() - interval '10 days' WHERE id = '${N_NEGOCIO}'`);
    assert.ok(!ids(await lista(USER_LAURA)).includes(N_NEGOCIO), 'el aviso nació antes de este vencimiento');
  });

  test('un video destacado es de la semana en que se avisó', async () => {
    assert.ok(ids(await lista(USER_MANAGER)).includes(N_BREAKOUT));
    // Los dos avisos del video, corridos una semana: el outlier sigue siendo el más viejo.
    await t.admin(`
      UPDATE notification SET created_at = now() - interval '8 days' WHERE id = '${N_BREAKOUT}';
      UPDATE notification SET created_at = now() - interval '10 days' WHERE id = '${N_OUTLIER}';
    `);
    assert.ok(!(await lista(USER_MANAGER)).some((f) => f.source === 'outlier'));
  });
});

describe('alcance (ACC-6)', () => {
  before(async () => {
    await sembrarAlcance(t);
    await t.admin(`
      UPDATE social_connection SET status = 'error', status_detail = 'La cuenta ya no existe.' WHERE id = '${CONEXION_SOFIA}';
      UPDATE invoice SET due_on = CURRENT_DATE - 5 WHERE id = '${INVOICE_SOFIA}';
      INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id, next_action, next_action_due)
      VALUES ('${DEAL_SOFIA}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', 'Playa con la marca de Sofía', 'contactado',
              'Llamar a la marca de Sofía', now() - interval '2 days')
      ON CONFLICT DO NOTHING;
      INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status)
      VALUES ('${CANAL_SOFIA}', '${WORKSPACE_LAURA}', '${CREATOR_SOFIA}', 'email', 'gmail_oauth', 'sofia@viaja.test', 'sofia@viaja.test',
              'needs_reconnect')
      ON CONFLICT DO NOTHING;
      ${aviso({ id: N_SOFIA_CONEXION, kind: 'connection_error', severity: 'warning', entityType: 'social_connection', entityId: CONEXION_SOFIA, actionUrl: '/conexiones' })}
      ${aviso({ id: N_SOFIA_CANAL, kind: 'connection_error', severity: 'critical', entityType: 'outreach_channel_account', entityId: CANAL_SOFIA, actionUrl: '/ventas/canales' })}
      ${aviso({ id: N_SOFIA_FACTURA, kind: 'invoice_overdue', severity: 'warning', entityType: 'invoice', entityId: INVOICE_SOFIA, actionUrl: `/finanzas/facturas/${INVOICE_SOFIA}?recordatorio=2` })}
      ${aviso({ id: N_SOFIA_VIDEO, kind: 'outlier', severity: 'success', entityType: 'post', entityId: POST_SOFIA, actionUrl: '/resumen' })}
      ${aviso({ id: N_SOFIA_NEGOCIO, kind: 'deal_overdue', severity: 'warning', entityType: 'deal', entityId: DEAL_SOFIA, actionUrl: `/ventas/empresas/${EMPRESA_SOFIA}` })}
    `);
  }, SETUP_TIMEOUT);

  test('la dueña ve lo de Sofía en las cinco ramas; quien solo ve lo de Laura, en ninguna', async () => {
    const sofia = [N_SOFIA_CONEXION, N_SOFIA_CANAL, N_SOFIA_FACTURA, N_SOFIA_VIDEO, N_SOFIA_NEGOCIO];
    const duena = ids(await lista(USER_LAURA));
    for (const id of sofia) assert.ok(duena.includes(id), `la dueña debería ver ${id}`);
    const miembro = ids(await lista(USER_MIEMBRO));
    assert.deepEqual(miembro.filter((id) => sofia.includes(id)), []);
  });
});

describe('más de las que caben', () => {
  test('con más de MAX_HIGHLIGHTS avisos, devuelve el tope y `more`', async () => {
    const { rows: posts } = await t.db.asWorker((tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM post WHERE workspace_id = $1 AND NOT deleted_on_platform AND id <> $2 ORDER BY id LIMIT $3`,
        [WORKSPACE_LAURA, POST_D01_REEL_CAFE_ALMA, MAX_HIGHLIGHTS + 1],
      ));
    assert.equal(posts.length, MAX_HIGHLIGHTS + 1, 'el seed tiene videos de sobra');
    await t.admin(posts.map((p, i) => aviso({
      id: `0000000c-0000-4000-8000-0000000b${String(i).padStart(4, '0')}`, kind: 'outlier', severity: 'success', entityType: 'post',
      entityId: p.id, actionUrl: '/resumen',
    })).join('\n'));
    const { rows, more } = await leer(USER_LAURA, ['outlier']);
    assert.equal(rows.length, MAX_HIGHLIGHTS);
    assert.equal(more, true);
    const justo = await leer(USER_LAURA, ['connection']);
    assert.equal(justo.more, false);
  });
});
