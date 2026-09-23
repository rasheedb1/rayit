/**
 * El reporte a la marca (CAM-6) de punta a punta sobre Postgres embebido
 * con el seed, como mc_app y sin red: generar, regenerar, marcar
 * enviado, abrir sin sesión por withPublicShare, versiones y RLS.
 *
 * Lo que de verdad se comprueba aquí y no se puede comprobar en core:
 *   - LA prueba clave: generar, enviar, insertar un snapshot nuevo del
 *     post (y de la marca, y del resultado) y leer el público → el
 *     mismo documento byte a byte;
 *   - que el enlace abra SIN workspace fijado (withPublicShare), que un
 *     borrador y un slug desconocido no abran nada, y que la primera
 *     apertura marque viewed_at una sola vez;
 *   - que enviar deje actividad en la empresa, aviso, bitácora y la
 *     campaña en «Reporte listo», y que repetirlo no escriba nada;
 *   - que el workspace vecino no vea ni genere nada, ni fijando a mano
 *     el parámetro del enlace (la sonda de 0030);
 *   - que la fila guardada no lleve PII ni parámetros de seguimiento.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isReportPayloadV1, reportForbiddenMatch, ReportAlreadySentError, ReportNotAvailableError, ReportNotSendableError } from '@mc/core';
import {
  generateReport, getReport, listCampaignReports, markReportSent, readPublicReport,
  CampaignNotFoundError, ReportNotFoundError,
  type TextosReporte, type WorkspaceTx,
} from '../src/index.ts';
import { LARGO_SLUG } from '../src/queries/cotizar.ts';
import {
  openTestDb, type TestDb,
  WORKSPACE_LAURA, COMPANY_CAFE_ALMA, CAMPAIGN_CAFE_ALMA, CAMPAIGN_FRESKO, POST_D01_REEL_CAFE_ALMA,
} from './pglite.ts';

const WORKSPACE_VECINO = '0000000c-0000-4000-8000-00000000c6c6';
/** Una campaña planeada y una cancelada de Laura, para «no se reporta». */
const CAMPAIGN_PLANEADA = '00000003-0000-4000-8000-00000ca0c601';
const CAMPAIGN_CANCELADA = '00000003-0000-4000-8000-00000ca0c602';

/** Marcas reconocibles en vez de las frases de messages.ts: se comprueba que la base guarda lo que la web compuso. */
const TEXTOS: TextosReporte = {
  actividadEnviado: ({ campaignName, via }) => `[reporte:${via}] ${campaignName}`,
  avisoEnviado: ({ companyName, campaignName, via }) => ({ title: `[aviso] ${companyName}`, body: `${campaignName} · ${via}` }),
};

let t: TestDb;
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);
const vecino = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_VECINO, fn);

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency, timezone, locale)
    VALUES ('${WORKSPACE_VECINO}', 'vecino-reporte', 'Vecino', 'creator', 'MXN', 'America/Mexico_City', 'es-MX')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on)
    VALUES ('${CAMPAIGN_PLANEADA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', 'Planeada', 'planned', DATE '2026-11-01', DATE '2026-11-08'),
           ('${CAMPAIGN_CANCELADA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', 'Cancelada', 'cancelled', DATE '2026-05-01', DATE '2026-05-08')
    ON CONFLICT DO NOTHING;
  `);
});

after(async () => {
  await t.close();
});

// ------------------------------------------------------------- generar

describe('generar el reporte de Café Alma', () => {
  test('nace en borrador, con slug impredecible y el payload v1 completo desde el seed', async () => {
    const r = await laura((tx) => generateReport(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(r.status, 'draft');
    assert.equal(r.campaignId, CAMPAIGN_CAFE_ALMA);
    assert.equal(r.slug.length, LARGO_SLUG);
    assert.equal(r.sentAt, null);
    assert.equal(r.viewedAt, null);
    assert.equal(r.supersededById, null);
    const p = r.payload;
    assert.ok(isReportPayloadV1(p));
    assert.equal(p.company.name, 'Café Alma');
    assert.deepEqual(p.creator, { displayName: 'Laura Méndez', handle: 'laura.cocinafacil' });
    assert.deepEqual([p.locale, p.timezone, p.currency], ['es-CO', 'America/Bogota', 'COP']);
    assert.equal(p.campaign.name, 'Lanzamiento cold brew');
    assert.equal(p.campaign.amount, '3100000.00');
    assert.equal(p.campaign.trackingCode, 'LAURA15');
    // El enlace rastreado del seed lleva UTM: se guarda sin parámetros.
    assert.equal(p.campaign.trackingUrl, 'https://cafealma.co/cold-brew');
    // Café Alma se creó a mano en el seed: sin cotización, cortes por defecto.
    assert.equal(p.agreed, null);
    assert.deepEqual(p.cutsHours, [168, 720]);
    // Dos posts, el reel principal primero, con su corte a 30 días (la lectura manual del seed 0003) y su última lectura.
    assert.equal(p.posts.length, 2);
    const reel = p.posts[0]!;
    assert.equal(reel.platformId, 'instagram');
    assert.equal(reel.isPrimary, true);
    assert.equal(reel.deliverable, 'reel');
    assert.equal(reel.cuts.length, 2);
    assert.ok(reel.cuts[1] && reel.cuts[1].cutHours === 720 && reel.cuts[1].views !== null);
    assert.ok(reel.latest && reel.latest.views !== null && reel.latest.capturedAt);
    // El resultado consolidado del seed, copiado sin aritmética.
    assert.equal(p.result?.views, 712000);
    assert.equal(p.result?.attributedRevenue, '8400000.00');
    assert.equal(p.result?.cpm, '11800.00');
    assert.deepEqual(p.result?.missingInputs, ['brand_csv_sales']);
    // La curva de @cafealma: 60 días diarios desde el 4 de julio, ordenados.
    assert.equal(p.brandFollowers?.platformId, 'instagram');
    assert.equal(p.brandFollowers?.handle, 'cafealma');
    assert.equal(p.brandFollowers?.baselineFrom, '2026-07-27');
    assert.equal(p.brandFollowers?.points.length, 60);
    assert.deepEqual(p.brandFollowers?.points[0], { day: '2026-07-04', followers: 18200 });
    // Los aportes de la marca, sin sus notas.
    assert.equal(p.brandInputs.length, 2);
    assert.deepEqual(p.brandInputs.map((b) => b.kind), ['code_redemptions', 'revenue']);
    assert.equal(p.brandInputs[1]?.value, '8400000.00');
  });

  test('la fila guardada no lleva PII, notas, brief, ids internos ni parámetros del enlace (dump-text)', async () => {
    const [r] = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    const { rows } = await laura((tx) => tx.query<{ payload: unknown; white_label: unknown }>('SELECT payload, white_label FROM report WHERE id = $1', [r!.id]));
    const json = JSON.stringify(rows[0]!.payload);
    assert.equal(reportForbiddenMatch(json), null, json);
    assert.ok(!json.includes('reportados por la marca'), 'las notas de campaign_brand_input no viajan');
    assert.ok(!json.includes('Código propio y enlace rastreado'), 'el brief no viaja');
    assert.ok(!json.includes('17841400000000e01'), 'el id externo de la cuenta de la marca no viaja');
    assert.ok(!json.includes(POST_D01_REEL_CAFE_ALMA), 'los ids de los posts no viajan');
    assert.equal(reportForbiddenMatch(JSON.stringify(rows[0]!.white_label)), null);
  });

  test('mientras es borrador, generar de nuevo lo reemplaza: mismo id, mismo slug, cifras nuevas', async () => {
    const antes = (await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA)))[0]!;
    const otra = await laura((tx) => generateReport(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(otra.id, antes.id);
    assert.equal(otra.slug, antes.slug);
    assert.equal(otra.status, 'draft');
    assert.ok(otra.createdAt >= antes.createdAt);
    assert.equal((await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA))).length, 1);
  });

  test('una campaña planeada o cancelada no se reporta, con el mensaje en español', async () => {
    await assert.rejects(laura((tx) => generateReport(tx, CAMPAIGN_PLANEADA)), (e: unknown) => e instanceof ReportNotAvailableError && /planeada/.test(e.messageEs));
    await assert.rejects(laura((tx) => generateReport(tx, CAMPAIGN_CANCELADA)), (e: unknown) => e instanceof ReportNotAvailableError && /cancelada/.test(e.messageEs));
    await assert.rejects(laura((tx) => generateReport(tx, 'no-es-uuid')), CampaignNotFoundError);
  });

  test('un borrador no abre desde el enlace público: not_found, igual que un slug desconocido', async () => {
    const [r] = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    assert.deepEqual(await t.db.withPublicShare((tx) => readPublicReport(tx, r!.slug)), { status: 'not_found' });
    assert.deepEqual(await t.db.withPublicShare((tx) => readPublicReport(tx, 'esto-no-existe')), { status: 'not_found' });
    assert.deepEqual(await t.db.withPublicShare((tx) => readPublicReport(tx, '')), { status: 'not_found' });
    assert.deepEqual(await t.db.withPublicShare((tx) => readPublicReport(tx, 'x'.repeat(200))), { status: 'not_found' });
  });
});

// ----------------------------------------------------------- aislamiento

describe('RLS: el workspace vecino no ve ni genera nada', () => {
  test('generar, listar y leer desde el vecino', async () => {
    await assert.rejects(vecino((tx) => generateReport(tx, CAMPAIGN_CAFE_ALMA)), CampaignNotFoundError);
    assert.deepEqual(await vecino((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA)), []);
    const [r] = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(await vecino((tx) => getReport(tx, r!.id)), null);
    await assert.rejects(vecino((tx) => markReportSent(tx, r!.id, 'link', TEXTOS)), ReportNotFoundError);
  });

  test('la sonda: fijar app.public_share a mano no abre la fila a mc_app (la política es TO mc_public_share)', async () => {
    const [r] = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    const desdeElVecino = await vecino(async (tx) => {
      await tx.query("SELECT set_config('app.public_share', $1, true)", [r!.slug]);
      return tx.query('SELECT id FROM report WHERE slug = $1', [r!.slug]);
    });
    assert.equal(desdeElVecino.rows.length, 0);
    const sinWorkspace = await t.db.withPublicShare(async (tx) => {
      await tx.query("SELECT set_config('app.public_share', $1, true)", [r!.slug]);
      return tx.query('SELECT id FROM report WHERE slug = $1', [r!.slug]);
    });
    assert.equal(sinWorkspace.rows.length, 0);
  });
});

// ------------------------------------------------------------- enviar

describe('marcar enviado', () => {
  let enviado: { id: string; slug: string };

  test('deja el reporte enviado, la actividad en la empresa, el aviso y la bitácora', async () => {
    const [borrador] = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    const r = await laura((tx) => markReportSent(tx, borrador!.id, 'link', TEXTOS));
    enviado = { id: r.id, slug: r.slug };
    assert.equal(r.status, 'sent');
    assert.equal(r.sentVia, 'link');
    assert.ok(r.sentAt);
    assert.equal(r.viewedAt, null);

    const act = await laura((tx) =>
      tx.query<{ company_id: string; deal_id: string | null; subject: string; metadata: Record<string, unknown> }>(
        "SELECT company_id, deal_id, subject, metadata FROM activity WHERE kind = 'report_sent' AND metadata->>'reportId' = $1",
        [r.id],
      ),
    );
    assert.equal(act.rows.length, 1);
    assert.equal(act.rows[0]!.company_id, COMPANY_CAFE_ALMA);
    assert.equal(act.rows[0]!.subject, '[reporte:link] Lanzamiento cold brew');
    assert.equal(act.rows[0]!.metadata.kind, 'report_sent');
    assert.equal(act.rows[0]!.metadata.sentVia, 'link');

    const notif = await laura((tx) =>
      tx.query<{ title_es: string; body_es: string; severity: string; action_url: string }>(
        "SELECT title_es, body_es, severity, action_url FROM notification WHERE kind = 'report_sent' AND entity_type = 'report' AND entity_id = $1",
        [r.id],
      ),
    );
    assert.equal(notif.rows.length, 1);
    assert.equal(notif.rows[0]!.title_es, '[aviso] Café Alma');
    assert.equal(notif.rows[0]!.body_es, 'Lanzamiento cold brew · link');
    assert.equal(notif.rows[0]!.severity, 'success');
    assert.equal(notif.rows[0]!.action_url, `/campanas/${CAMPAIGN_CAFE_ALMA}#reporte`);

    const audit = await laura((tx) =>
      tx.query<{ action: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        "SELECT action, before, after FROM audit_log WHERE entity_type = 'report' AND entity_id = $1",
        [r.id],
      ),
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.action, 'report.sent');
    assert.deepEqual(audit.rows[0]!.before, { status: 'draft' });
    assert.equal(audit.rows[0]!.after.sentVia, 'link');
    assert.equal(reportForbiddenMatch(JSON.stringify(audit.rows[0]!.after)), null);
  });

  test('repetirlo no escribe nada, y un canal fuera del MVP se rechaza', async () => {
    await assert.rejects(laura((tx) => markReportSent(tx, enviado.id, 'pdf', TEXTOS)), ReportAlreadySentError);
    await assert.rejects(laura((tx) => markReportSent(tx, enviado.id, 'email', TEXTOS)), ReportNotSendableError);
    await assert.rejects(laura((tx) => markReportSent(tx, '00000000-0000-4000-8000-000000000000', 'link', TEXTOS)), ReportNotFoundError);
    const { rows } = await laura((tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM activity WHERE kind = 'report_sent' AND metadata->>'reportId' = $1", [enviado.id]));
    assert.equal(rows[0]!.n, 1);
  });

  test('una campaña en medición pasa a «Reporte listo» al enviar; una ya reportada no se toca', async () => {
    const { rows: antes } = await laura((tx) => tx.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1', [CAMPAIGN_FRESKO]));
    assert.equal(antes[0]!.status, 'measuring');
    const r = await laura((tx) => generateReport(tx, CAMPAIGN_FRESKO));
    await laura((tx) => markReportSent(tx, r.id, 'pdf', TEXTOS));
    const { rows } = await laura((tx) => tx.query<{ status: string }>('SELECT status FROM campaign WHERE id = ANY($1::uuid[]) ORDER BY id', [[CAMPAIGN_CAFE_ALMA, CAMPAIGN_FRESKO]]));
    assert.deepEqual(rows.map((x) => x.status), ['reported', 'reported']);
    const detalle = await laura((tx) => getReport(tx, r.id));
    assert.equal(detalle?.sentVia, 'pdf');
  });

  test('la marca lo abre sin sesión: la primera apertura marca viewed_at una sola vez y cada apertura suma', async () => {
    const previa = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug, { count: false }));
    assert.equal(previa.status, 'ok');
    if (previa.status !== 'ok') return;
    assert.equal(previa.report.status, 'sent');
    assert.equal(previa.report.viewedAt, null);
    assert.equal(previa.report.superseded, false);

    const primera = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug));
    assert.equal(primera.status, 'ok');
    if (primera.status !== 'ok') return;
    assert.equal(primera.report.status, 'viewed');
    assert.ok(primera.report.viewedAt);
    assert.equal(primera.report.company.name, 'Café Alma');
    assert.equal(primera.report.slug, enviado.slug);

    const segunda = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug));
    assert.equal(segunda.status, 'ok');
    if (segunda.status !== 'ok') return;
    assert.equal(segunda.report.viewedAt, primera.report.viewedAt);

    const fila = await laura((tx) => getReport(tx, enviado.id));
    assert.equal(fila?.status, 'viewed');
    assert.equal(fila?.viewCount, 2);
    assert.equal(fila?.viewedAt, primera.report.viewedAt);
  });

  test('LA CLAVE: el reporte enviado no cambia aunque lleguen snapshots nuevos (byte a byte)', async () => {
    const antes = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug));
    assert.equal(antes.status, 'ok');
    if (antes.status !== 'ok') return;
    const jsonAntes = JSON.stringify(antes.report);

    // Llegan lecturas nuevas: del post, de la cuenta de la marca y del
    // resultado consolidado. Como superusuario, que es como escribe el
    // worker (mc_worker se salta RLS).
    await t.admin(`
      INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, total_interactions, source)
      VALUES ('${POST_D01_REEL_CAFE_ALMA}', '${WORKSPACE_LAURA}', now(), 2000, 999999, 700000, 50000, 900, 4000, 8000, 62900, 'api');
      INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, handle, day, followers, source)
      VALUES ('${CAMPAIGN_CAFE_ALMA}', '${COMPANY_CAFE_ALMA}', 'instagram', 'cafealma', DATE '2026-09-22', 25000, 'business_discovery')
      ON CONFLICT DO NOTHING;
      UPDATE campaign_result SET views = 999999, computed_at = now() WHERE campaign_id = '${CAMPAIGN_CAFE_ALMA}';
    `);

    const despues = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug));
    assert.equal(despues.status, 'ok');
    if (despues.status !== 'ok') return;
    assert.equal(JSON.stringify(despues.report), jsonAntes);
    assert.equal(despues.report.result?.views, 712000);
    assert.equal(despues.report.brandFollowers?.points.length, 60);

    // Y las lecturas SÍ llegaron: un reporte nuevo las trae.
    const nuevo = await laura((tx) => generateReport(tx, CAMPAIGN_CAFE_ALMA));
    assert.notEqual(nuevo.id, enviado.id);
    assert.notEqual(nuevo.slug, enviado.slug);
    assert.equal(nuevo.status, 'draft');
    assert.equal(nuevo.payload.result?.views, 999999);
    assert.equal(nuevo.payload.posts[0]?.latest?.views, 999999);
    assert.equal(nuevo.payload.brandFollowers?.points.length, 61);
  });

  test('versiones: al enviar el nuevo, el anterior sigue abriendo con «hay una versión más reciente»', async () => {
    const lista = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(lista.length, 2);
    assert.equal(lista[0]!.status, 'draft');
    assert.equal(lista[1]!.id, enviado.id);
    assert.equal(lista[1]!.supersededById, null);

    // Todavía en borrador: el viejo no avisa nada (nadie puede ver el nuevo).
    const viejoAntes = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug, { count: false }));
    assert.equal(viejoAntes.status === 'ok' && viejoAntes.report.superseded, false);

    const nuevo = await laura((tx) => markReportSent(tx, lista[0]!.id, 'link', TEXTOS));
    assert.equal(nuevo.status, 'sent');
    const despues = await laura((tx) => listCampaignReports(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(despues[1]!.supersededById, nuevo.id);
    assert.equal(despues[0]!.supersededById, null);

    const viejo = await t.db.withPublicShare((tx) => readPublicReport(tx, enviado.slug, { count: false }));
    assert.equal(viejo.status, 'ok');
    if (viejo.status !== 'ok') return;
    assert.equal(viejo.report.superseded, true);
    assert.equal(viejo.report.result?.views, 712000, 'el viejo sigue diciendo lo que dijo');
    const reciente = await t.db.withPublicShare((tx) => readPublicReport(tx, nuevo.slug, { count: false }));
    assert.equal(reciente.status === 'ok' && reciente.report.superseded, false);
    assert.equal(reciente.status === 'ok' && reciente.report.result?.views, 999999);
  });

  test('el permiso del enlace no sobrevive a la llamada: después de public_report, report sigue cerrado', async () => {
    const { rows } = await t.db.withPublicShare(async (tx) => {
      await readPublicReport(tx, enviado.slug, { count: false });
      return tx.query<{ n: number }>('SELECT count(*)::int AS n FROM report');
    });
    assert.equal(rows[0]!.n, 0);
  });
});
