/**
 * RES-3 · «Lo que importa esta semana» contra el Postgres embebido con
 * el seed, como mc_app y sin red.
 *
 * Los avisos se siembran aquí con la forma EXACTA que dejan sus
 * productores (kind, entity_type, action_url, user_id); que los
 * productores de verdad escriban eso lo prueba, de punta a punta,
 * apps/worker/test/lo-que-importa.test.ts. Aquí van las reglas de la
 * lectura (queries/resumen-semana.ts):
 *
 *   - las cuatro fuentes dan su fila, en orden de urgencia;
 *   - una fila por cosa: el aviso más reciente, y el «Entendido» no
 *     resucita el anterior;
 *   - solo lo que SIGUE siendo cierto hoy;
 *   - «Entendido» es de la persona (0078), no toca read_at y no se puede
 *     dar por otro ni sobre un aviso ajeno;
 *   - sin finanzas.factura.ver (los permisos REALES del rol Mánager,
 *     leídos de role_permission) no hay fila de factura;
 *   - el alcance de ACC-6: quien ve solo lo de Laura no ve lo de Sofía.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Permiso } from '@mc/core';
import type { WorkspaceTx } from '../src/client.ts';
import { getSessionPermissions } from '../src/queries/accesos.ts';
import {
  acknowledgeHighlight,
  compareHighlights,
  listWeeklyHighlights,
  WEEKLY_SOURCES,
  weeklySourcesFor,
  type WeeklyHighlight,
  type WeeklySource,
} from '../src/queries/resumen-semana.ts';
import { markReminderSent } from '../src/queries/finanzas.ts';
import { openTestDb, POST_D01_REEL_CAFE_ALMA, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import {
  CONEXION_SOFIA, INVOICE_SOFIA, POST_SOFIA, sembrarAlcance, USER_LAURA, USER_MIEMBRO,
} from './alcance.ts';

/** La cuenta de TikTok de Laura (seed 0002). */
const CONEXION_TIKTOK = '00000002-0000-4000-8000-0000000000c2';
/** FV-2026-007, abierta y vencida hace 41 días (seed 0003). */
const FV_007 = '00000003-0000-4000-8000-0000fac26007';
/** Una Mánager sin alcance: ve todo el espacio, pero su rol no tiene Finanzas. */
const USER_MANAGER = '0000000c-0000-4000-8000-0000000000a1';
/** Otro espacio, con su propio aviso. */
const WS_AJENO = '0000000c-0000-4000-8000-000000000051';

const N = (n: string) => `0000000c-0000-4000-8000-00000000${n}`;
const N_CONEXION = N('0c01');
const N_FACTURA_PASO_0 = N('0f00');
const N_FACTURA = N('0f01');
const N_NEGOCIO = N('0d01');
const N_OUTLIER = N('0a01');
const N_BREAKOUT = N('0a02');
const N_AJENO = N('0e01');
const N_SOFIA_CONEXION = N('5c01');
const N_SOFIA_FACTURA = N('5f01');
const N_SOFIA_VIDEO = N('5a01');

let t: TestDb;
/** Un negocio abierto de Laura con la acción vencida (seed 0002). */
let negocio: { id: string; company_id: string };

const como = <T>(userId: string | null, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> =>
  userId === null ? t.db.withWorkspace(WORKSPACE_LAURA, fn) : t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId });

const lista = (userId: string | null, sources: readonly WeeklySource[] = WEEKLY_SOURCES) =>
  como(userId, (tx) => listWeeklyHighlights(tx, sources));

const permisosDe = async (userId: string): Promise<ReadonlySet<Permiso>> =>
  new Set((await como(userId, (tx) => getSessionPermissions(tx))) as Permiso[]);

const ids = (filas: readonly WeeklyHighlight[]) => filas.map((f) => f.id);

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
    ${aviso({ id: N_FACTURA_PASO_0, kind: 'invoice_overdue', severity: 'info', entityType: 'invoice', entityId: FV_007, actionUrl: `/finanzas/facturas/${FV_007}?recordatorio=0`, createdAt: "now() - interval '41 days'" })}
    ${aviso({ id: N_FACTURA, kind: 'invoice_overdue', severity: 'warning', entityType: 'invoice', entityId: FV_007, actionUrl: `/finanzas/facturas/${FV_007}?recordatorio=21`, createdAt: "now() - interval '20 days'" })}
    ${aviso({ id: N_NEGOCIO, kind: 'deal_overdue', severity: 'warning', entityType: 'deal', entityId: negocio.id, actionUrl: `/ventas/empresas/${negocio.company_id}`, userId: USER_LAURA })}
    ${aviso({ id: N_OUTLIER, kind: 'outlier', severity: 'success', entityType: 'post', entityId: POST_D01_REEL_CAFE_ALMA, actionUrl: '/resumen', createdAt: "now() - interval '3 days'" })}
    ${aviso({ id: N_BREAKOUT, kind: 'breakout', severity: 'success', entityType: 'post', entityId: POST_D01_REEL_CAFE_ALMA, actionUrl: '/resumen', createdAt: "now() - interval '1 day'" })}
    ${aviso({ id: N_AJENO, kind: 'connection_error', severity: 'critical', entityType: 'social_connection', entityId: CONEXION_TIKTOK, actionUrl: '/conexiones', workspaceId: WS_AJENO })}
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t.close();
});

describe('las cuatro fuentes', () => {
  test('cada una da su fila, una por cosa, en orden de urgencia', async () => {
    const filas = await lista(USER_LAURA);
    assert.deepEqual(filas.map((f) => f.source), ['connection', 'invoice', 'deal', 'outlier']);
    assert.deepEqual(ids(filas), [N_CONEXION, N_FACTURA, N_NEGOCIO, N_BREAKOUT], 'el aviso más reciente de cada cosa');
    for (let i = 1; i < filas.length; i++) assert.ok(compareHighlights(filas[i - 1]!, filas[i]!) < 0);

    const [conexion, factura, trato, video] = filas;
    assert.ok(conexion?.source === 'connection');
    assert.equal(conexion.status, 'needs_reauth');
    assert.equal(conexion.platformId, 'tiktok');
    assert.equal(conexion.detail, 'TikTok pidió volver a autorizar la cuenta.');
    assert.equal(conexion.actionUrl, '/conexiones');

    assert.ok(factura?.source === 'invoice');
    assert.equal(factura.invoiceNumber, 'FV-2026-007');
    assert.equal(factura.outstanding, '1100000.00');
    assert.equal(factura.currency, 'COP');
    // El seed fija due_on con CURRENT_DATE (UTC) y la mora se cuenta en Bogotá: 40 entre las 0:00 y las 5:00 UTC.
    assert.ok([40, 41].includes(factura.daysOverdue), `mora ${factura.daysOverdue}`);
    assert.equal(factura.actionUrl, `/finanzas/facturas/${FV_007}?recordatorio=21`);

    assert.ok(trato?.source === 'deal');
    assert.equal(trato.dealId, negocio.id);
    assert.equal(trato.companyId, negocio.company_id);
    assert.equal(trato.dueState, 'vencido');
    assert.ok(trato.daysOverdue >= 0);
    assert.ok(trato.nextAction.length > 0);

    assert.ok(video?.source === 'outlier');
    assert.equal(video.tier, 'breakout');
    assert.equal(video.postId, POST_D01_REEL_CAFE_ALMA);
    assert.equal(video.viewsVsMedian, '5.971', 'el múltiplo es el de post_score, no uno recalculado');
    assert.equal(video.ageHoursCut, 720);
  });

  test('una fuente que no es de la lista no elige SQL: se ignora', async () => {
    const filas = await lista(USER_LAURA, ['invoice', 'nada' as WeeklySource]);
    assert.deepEqual(filas.map((f) => f.source), ['invoice']);
    assert.deepEqual(await lista(USER_LAURA, []), []);
  });
});

describe('permisos y personas', () => {
  test('sin finanzas.factura.ver (el rol Mánager, leído de la base) no hay fila de factura', async () => {
    const manager = weeklySourcesFor(await permisosDe(USER_MANAGER));
    assert.deepEqual(manager, ['connection', 'deal', 'outlier']);
    assert.deepEqual(weeklySourcesFor(await permisosDe(USER_LAURA)), [...WEEKLY_SOURCES], 'la dueña ve las cuatro');

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
    assert.deepEqual(ajeno, [], 'la cuenta del aviso ajeno es de otro espacio: RLS no la deja unir');
  });
});

describe('«Entendido»', () => {
  test('es de la persona: a Laura se le va la fila y a la Mánager no; read_at no se toca', async () => {
    assert.equal(await como(USER_LAURA, (tx) => acknowledgeHighlight(tx, N_BREAKOUT)), true);
    const laura = await lista(USER_LAURA);
    assert.ok(!laura.some((f) => f.source === 'outlier'), 'entender el breakout no resucita el outlier de antes');
    assert.ok(ids(await lista(USER_MANAGER)).includes(N_BREAKOUT));

    const aviso = await como(USER_LAURA, (tx) =>
      tx.query<{ read_at: unknown }>('SELECT read_at FROM notification WHERE id = $1', [N_BREAKOUT]));
    assert.equal(aviso.rows[0]?.read_at, null);
  });

  test('repetir el clic no escribe otra fila', async () => {
    assert.equal(await como(USER_LAURA, (tx) => acknowledgeHighlight(tx, N_BREAKOUT)), true);
    const n = await como(USER_LAURA, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM notification_ack WHERE notification_id = $1', [N_BREAKOUT]));
    assert.equal(n.rows[0]?.n, 1);
  });

  test('sin persona (demo) también vale, y es solo de la demo', async () => {
    assert.equal(await como(null, (tx) => acknowledgeHighlight(tx, N_CONEXION)), true);
    assert.ok(!ids(await lista(null)).includes(N_CONEXION));
    assert.ok(ids(await lista(USER_LAURA)).includes(N_CONEXION));
  });

  test('no vale para un aviso que no es del bloque, de otro espacio, de otra persona o con un id imposible', async () => {
    const conexionAgregada = '00000003-0000-4000-8000-0000ac080002';
    assert.equal(await como(USER_LAURA, (tx) => acknowledgeHighlight(tx, conexionAgregada)), false);
    assert.equal(await como(USER_LAURA, (tx) => acknowledgeHighlight(tx, N_AJENO)), false);
    assert.equal(await como(USER_MANAGER, (tx) => acknowledgeHighlight(tx, N_NEGOCIO)), false);
    assert.equal(await como(USER_LAURA, (tx) => acknowledgeHighlight(tx, 'no-es-un-id')), false);
  });

  test('nadie lo da por otro, y no se corrige ni se borra', async () => {
    await assert.rejects(
      como(USER_LAURA, (tx) =>
        tx.query(
          'INSERT INTO notification_ack (workspace_id, notification_id, user_id) VALUES (current_workspace_id(), $1, $2)',
          [N_FACTURA, USER_MANAGER],
        )),
      /row-level security|política|policy/i,
    );
    await assert.rejects(como(USER_LAURA, (tx) => tx.query('DELETE FROM notification_ack')), /permission denied|permiso/i);
    await assert.rejects(como(USER_LAURA, (tx) => tx.query('UPDATE notification_ack SET acked_at = now()')), /permission denied|permiso/i);
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
      ${aviso({ id: N_SOFIA_CONEXION, kind: 'connection_error', severity: 'warning', entityType: 'social_connection', entityId: CONEXION_SOFIA, actionUrl: '/conexiones' })}
      ${aviso({ id: N_SOFIA_FACTURA, kind: 'invoice_overdue', severity: 'warning', entityType: 'invoice', entityId: INVOICE_SOFIA, actionUrl: `/finanzas/facturas/${INVOICE_SOFIA}?recordatorio=0` })}
      ${aviso({ id: N_SOFIA_VIDEO, kind: 'outlier', severity: 'success', entityType: 'post', entityId: POST_SOFIA, actionUrl: '/resumen' })}
    `);
  }, SETUP_TIMEOUT);

  test('la dueña ve lo de Sofía; quien solo ve lo de Laura, no', async () => {
    const sofia = [N_SOFIA_CONEXION, N_SOFIA_FACTURA, N_SOFIA_VIDEO];
    const duena = ids(await lista(USER_LAURA));
    for (const id of sofia) assert.ok(duena.includes(id), `la dueña debería ver ${id}`);
    const miembro = ids(await lista(USER_MIEMBRO));
    assert.deepEqual(miembro.filter((id) => sofia.includes(id)), []);
  });
});
