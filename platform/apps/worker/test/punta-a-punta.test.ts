/**
 * E2E · la cadena entera de On Cue en UNA base, con el seed de la demo.
 *
 * La base la abre `createEmbeddedDb` de @mc/db: migraciones y seeds
 * reales, y los roles y privilegios como en Supabase. La web la usa como
 * mc_app con RLS (`withWorkspace`, con la identidad de quien actúa) y el
 * worker corre sus jobs sobre LA MISMA base como mc_worker
 * (`PgliteDatabase.wrap`), con `executeRun`: los mismos handlers,
 * redactor y job_run que en producción, sin pg-boss.
 *
 * Cada eslabón lee lo que escribió el anterior; ninguno se siembra a
 * mano salvo lo que en producción llega de fuera (las respuestas
 * grabadas de YouTube). Si un eslabón no está en main, su prueba se salta
 * con el motivo y la historia, en vez de fingir.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpTextColumns, findSecretInDump, FixtureFetch, InMemorySecretStore, loadFixtures, PostgresQuotaUsageStore, QuotaManager, refresherRegistry, withoutNetwork, loadPlatformLimits, type NetworkGuard } from '@mc/connectors';
import { createEmbeddedDb, type EmbeddedDb } from '@mc/db/embedded';
import { getSessionPermissions } from '@mc/db/queries/accesos';
import {
  addBrandInput, getCampaign, getCampaignResult, linkPost, listBrandFollowers, listCampaignPosts, recordBrandSnapshot, transitionCampaign,
  generateReport, markReportSent, readPublicReport, type TextosReporte,
} from '@mc/db/queries/campanas';
import { addPublicAccount } from '@mc/db/queries/conexiones';
import { acceptQuoteAndCreateCampaign, createQuote, sendQuote, type TextosCotizar } from '@mc/db/queries/cotizar';
import {
  createExpense, createInvoiceFromCampaign, createPlatformPayout, getCashflowInputs, getInvoice, getReceivablesKpis, getReserveState,
  listPayoutPlatforms, listReceivables, recordPayment, transitionInvoice, type TextosFinanzas,
} from '@mc/db/queries/finanzas';
import { createDeal } from '@mc/db/queries/ventas';
import { MIN_SAMPLE_FOR_BASELINE, mulRateHalfUp, projectCashflow, sumarMeses, ultimoDiaDelMes, ultimoMesCerrado } from '@mc/core';
import type { PGlite } from '@electric-sql/pglite';
import { allJobs } from '../src/jobs/index.ts';
import { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { loadJobDefinitions } from '../src/runner/definitions.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { JobRegistry, type JobDefinition } from '../src/runner/registry.ts';
import { CHAIN_SOURCE, executeRun, type RunOutcome } from '../src/runner/run.ts';

const WORKSPACE_LAURA = '00000002-0000-4000-8000-000000000001';
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
/** El Mánager del seed (0002): membership con el rol de sistema 'manager'. */
const USER_MANAGER = '00000002-0000-4000-8000-000000000004';
/** Una Contadora, creada aquí: el seed no trae ninguna. */
const USER_CONTADORA = '0000e2e0-0000-4000-8000-0000000000c1';
/** Otro workspace con su propia campaña: nadie de Laura la ve. */
const WORKSPACE_AJENO = '0000e2e0-0000-4000-8000-0000000000a1';
const CAMPAIGN_AJENA = '0000e2e0-0000-4000-8000-0000000000a2';
const COMPANY_AJENA = '0000e2e0-0000-4000-8000-0000000000a3';

const TEXTOS_COT: TextosCotizar = {
  actividadEnviada: ({ quoteNumber }) => `[enviada] ${quoteNumber}`,
  actividadAceptada: ({ quoteNumber, via }) => `[aceptada:${via}] ${quoteNumber}`,
  actividadMonto: ({ quoteNumber, amountTo, currencyTo }) => `[monto] ${quoteNumber} ${amountTo} ${currencyTo}`,
  avisoAceptada: ({ companyName, quoteNumber, campaignName }) => ({ title: `[aviso] ${companyName} ${quoteNumber}`, body: campaignName ?? 'pendiente' }),
};
const TEXTOS_REPORTE: TextosReporte = {
  actividadEnviado: ({ campaignName, via }) => `[reporte:${via}] ${campaignName}`,
  avisoEnviado: ({ companyName, campaignName }) => ({ title: `[reporte] ${companyName}`, body: campaignName }),
};
const TEXTOS_FIN: TextosFinanzas = {
  avisoPagoRecibido: (p) => ({ title: `Pago recibido · ${p.invoiceNumber}`, body: `${p.companyName} · ${p.amount}` }),
};

/** Lo que en producción viene de la plataforma: las respuestas grabadas del canal de Nutrive. */
const ENV = { GOOGLE_API_KEY: 'AIza-e2e-SECRETO' };
const HANDLE = 'NutriveOficial';
const CANAL = 'UCnutrive00000000000000e4';
const AHORA = new Date('2026-09-23T06:00:00Z');
/** La primera lectura, a los siete días del primer video (167, 143 y 119 h): todas dentro del corte de 168 h. */
const DIA_7 = new Date('2026-09-08T14:00:00Z');
/** La marca del seed (0002): sus redes (Instagram «nutrive», YouTube «NutriveOficial») pasan a la campaña. */
const COMPANY_NUTRIVE = '00000002-0000-4000-8000-0000000000e4';

let web: EmbeddedDb;
let worker: PgliteDatabase;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let definitions: Map<string, JobDefinition>;
let quota: QuotaManager;
const sink = new MemorySink();
const logger = createLogger({ level: 'debug', sink });
const registry = new JobRegistry(allJobs);

const asLaura = <T,>(fn: Parameters<EmbeddedDb['withWorkspace']>[1] extends (tx: infer X) => Promise<unknown> ? (tx: X) => Promise<T> : never) =>
  web.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_LAURA });

/** Corre un job como en producción (executeRun: job_run, redactor, conectores) sobre la base compartida. */
async function correr(jobId: string, payload: Record<string, unknown> = { source: 'e2e' }, now = AHORA): Promise<RunOutcome> {
  const definition = definitions.get(jobId);
  const registration = registry.get(jobId);
  assert.ok(definition && registration, `${jobId} tiene definición y handler`);
  return executeRun(
    { definition, registration, payload, attempt: 1, bossJobId: `e2e:${jobId}` },
    { db: worker, logger, secrets: new InMemorySecretStore(), refreshers: refresherRegistry([]), quota, http: { fetch: fetch.fetch }, env: ENV, now: () => now },
  );
}

/** Las cuentas de Nutrive en el seed, como las copia CAM-2 a la campaña. */
const expect_cuentas = () => [{ platform_id: 'instagram', handle: 'nutrive' }, { platform_id: 'youtube', handle: 'NutriveOficial' }];

let connectionId: string;
let inicio: string;
/** Lo que cada eslabón deja para el siguiente. */
const cadena: {
  companyId?: string; quoteId?: string; campaignId?: string; reportSlug?: string; reportId?: string;
  invoiceId?: string; invoiceNumber?: string; paymentId?: string; expenseId?: string; payoutIds: string[]; postIds: string[];
} = { payoutIds: [], postIds: [] };

const asManager = <T,>(fn: Parameters<typeof asLaura<T>>[0]) => web.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_MANAGER });
const asContadora = <T,>(fn: Parameters<typeof asLaura<T>>[0]) => web.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_CONTADORA });

before(async () => {
  guard = withoutNetwork();
  web = await createEmbeddedDb();
  const pglite = await web.raw(async (p: PGlite) => p);
  worker = PgliteDatabase.wrap(pglite, 'mc_worker');
  definitions = new Map((await loadJobDefinitions(worker)).map((d) => [d.id, d]));
  quota = new QuotaManager({ limits: await loadPlatformLimits(worker, logger), store: new PostgresQuotaUsageStore(worker), logger, now: () => AHORA });
  await web.execAsSuperuser(`
    INSERT INTO app_user (id, email, name) VALUES ('${USER_CONTADORA}', 'contadora-e2e@ejemplo.com', 'Contadora E2E') ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WORKSPACE_LAURA}', '${USER_CONTADORA}', system_role_id('creator', 'finance')) ON CONFLICT DO NOTHING;
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-e2e', 'Ajeno E2E') ON CONFLICT DO NOTHING;
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_AJENA}', 'Marca ajena', '${WORKSPACE_AJENO}') ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, currency) VALUES ('${CAMPAIGN_AJENA}', '${WORKSPACE_AJENO}', '${COMPANY_AJENA}', 'Campaña ajena', 'live', 'COP') ON CONFLICT DO NOTHING;
  `);
  inicio = (await web.queryAsSuperuser<{ t: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)).rows[0]!.t;
  fetch = new FixtureFetch(await loadFixtures('youtube', [['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'canal.ok']]));
}, { timeout: 600_000 });

after(async () => {
  guard?.restore();
  await web?.close();
});

describe('Conexiones: de la cuenta por @ al puntaje', () => {
  test('1 · la cuenta se agrega por su @ (CON-10), como mc_app y con la bitácora', async () => {
    const r = await asLaura((tx) => addPublicAccount(tx, {
      creatorId: CREATOR_LAURA, platformId: 'youtube', handle: HANDLE, externalAccountId: CANAL,
      displayName: 'Nutrive', avatarUrl: null, profileUrl: null, accountType: 'creator',
    }));
    connectionId = r.id;
    assert.ok(connectionId);
  });

  test('2 · collect.posts y collect.post_metrics leen las publicaciones y sus cifras (CON-5), dos días distintos', async () => {
    const posts = await correr('collect.posts', { workspaceId: WORKSPACE_LAURA, connectionId }, DIA_7);
    assert.equal(posts.status, 'ok', String(posts.error));
    assert.equal(posts.result?.processed, 1, 'una cuenta revisada');
    for (const dia of [DIA_7, AHORA]) {
      const metrics = await correr('collect.post_metrics', { workspaceId: WORKSPACE_LAURA, connectionId }, dia);
      assert.equal(metrics.status, 'ok', String(metrics.error));
      assert.equal(metrics.result?.processed, 3, `tres lecturas el ${dia.toISOString()}`);
    }
  });

  test('3 · compute.baseline y compute.post_score encadenados (CON-6)', async () => {
    const base = await correr('compute.baseline', { source: CHAIN_SOURCE, after: 'collect.post_metrics', workspaceId: WORKSPACE_LAURA });
    assert.equal(base.status, 'ok', String(base.error));
    const score = await correr('compute.post_score', { source: CHAIN_SOURCE, after: 'compute.baseline', workspaceId: WORKSPACE_LAURA });
    assert.equal(score.status, 'ok', String(score.error));
    // Cada video nuevo queda puntuado contra la línea base de Laura en YouTube, que ya
    // tiene los videos del seed: con ocho o más en la muestra, el múltiplo existe.
    const { rows } = await asLaura((tx) => tx.query<{ n: number; con_multiplo: number; muestra: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE s.views_vs_median IS NOT NULL)::int AS con_multiplo,
              (SELECT max(sample_size) FROM creator_baseline WHERE creator_id = $2 AND platform_id = 'youtube')::int AS muestra
         FROM post_score s JOIN post p ON p.id = s.post_id WHERE p.connection_id = $1`, [connectionId, CREATOR_LAURA]));
    assert.equal(rows[0]?.n, 3, 'un puntaje por video');
    assert.ok((rows[0]?.muestra ?? 0) >= MIN_SAMPLE_FOR_BASELINE, `la muestra de YouTube llega a ${MIN_SAMPLE_FOR_BASELINE}: ${rows[0]?.muestra}`);
    assert.equal(rows[0]?.con_multiplo, 3, 'con muestra suficiente, cada video tiene su múltiplo contra la mediana');
  });
});

describe('Cotizar → Campañas: el acuerdo se vuelve campaña y resultado', () => {
  test('4 · la cotización aceptada (COT-4) crea la campaña (CAM-2) con el monto con impuesto', async () => {
    cadena.companyId = COMPANY_NUTRIVE;
    const dealId = await asLaura((tx) => createDeal(tx, { companyId: cadena.companyId!, name: 'Paquete E2E', amount: '6000000' }));
    const q = await asLaura((tx) => createQuote(tx, {
      dealId, creatorId: CREATOR_LAURA, taxRate: '0.19',
      items: [{ deliverable: 'youtube', platformId: 'youtube', description: 'Video dedicado', quantity: 1, unitPrice: '6000000' }],
      campaignStartsOn: '2026-09-01', campaignEndsOn: '2026-09-10', paymentTermsDays: 30, reportCutsHours: [168],
    }));
    await asLaura((tx) => sendQuote(tx, q.id, TEXTOS_COT));
    const { quote, campaign } = await asLaura((tx) => acceptQuoteAndCreateCampaign(tx, q.id, TEXTOS_COT));
    assert.equal(quote.status, 'accepted');
    assert.ok(campaign, 'con ventana acordada nace la campaña');
    cadena.quoteId = quote.id;
    cadena.campaignId = campaign.campaignId;
    const c = await asLaura((tx) => getCampaign(tx, campaign.campaignId));
    assert.equal(c?.status, 'planned');
    assert.equal(c?.amount, '7140000.00', '6 000 000 + 19 %');
    assert.equal(c?.companyId, cadena.companyId);
    assert.deepEqual(c?.brandAccounts, expect_cuentas(), 'las cuentas de la marca salen de company.socials');
  });

  test('5 · los videos que trajo el recolector se asocian a la campaña (CAM-1)', async () => {
    const { rows } = await asLaura((tx) => tx.query<{ id: string }>(
      'SELECT id FROM post WHERE connection_id = $1 ORDER BY published_at', [connectionId]));
    assert.equal(rows.length, 3, 'los tres videos de la respuesta grabada');
    cadena.postIds = rows.map((r) => r.id);
    for (const [i, postId] of cadena.postIds.entries()) {
      await asLaura((tx) => linkPost(tx, { campaignId: cadena.campaignId!, postId, deliverable: 'youtube', isPrimary: i === 0 }));
    }
    const asociados = await asLaura((tx) => listCampaignPosts(tx, cadena.campaignId!));
    assert.equal(asociados.length, 3);
    await asLaura((tx) => transitionCampaign(tx, cadena.campaignId!, 'live'));
  });

  test('6 · la marca aporta sus cifras (CAM-4)', async () => {
    const r = await asLaura((tx) => addBrandInput(tx, { campaignId: cadena.campaignId!, kind: 'code_redemptions', day: '2026-09-08', value: '120' }));
    assert.ok(r);
    await asLaura((tx) => addBrandInput(tx, { campaignId: cadena.campaignId!, kind: 'revenue', day: '2026-09-08', value: '2400000.00' }));
  });

  test('7 · los seguidores de la marca antes y durante (CAM-3, «Actualizar ahora»)', async () => {
    for (const [day, followers] of [['2026-08-20', 10000], ['2026-08-31', 10100], ['2026-09-09', 10900]] as const) {
      await asLaura((tx) => recordBrandSnapshot(tx, {
        campaignId: cadena.campaignId!, companyId: cadena.companyId!, platformId: 'instagram', day,
        handle: 'nutrive', externalAccountId: null, followers, mediaCount: null, source: 'instagram.business_discovery',
      }));
    }
    const curva = await asLaura((tx) => listBrandFollowers(tx, cadena.campaignId!));
    assert.ok(curva, 'la ficha tiene curva de seguidores');
  });

  test('8 · campaign.compute (el job de CAM-5, como mc_worker) deja el resultado que lee la ficha', async () => {
    await asLaura((tx) => transitionCampaign(tx, cadena.campaignId!, 'measuring'));
    const run = await correr('campaign.compute', { workspaceId: WORKSPACE_LAURA, campaignId: cadena.campaignId });
    assert.equal(run.status, 'ok', String(run.error));
    const r = await asLaura((tx) => getCampaignResult(tx, cadena.campaignId!));
    assert.ok(r, 'la ficha lee campaign_result');
    const meta = (await worker.query<{ metadata: unknown }>('SELECT metadata FROM job_run WHERE id = $1', [run.runId])).rows[0]?.metadata;
    assert.deepEqual(r.missingInputs.filter((m) => m === 'posts' || m === 'brand_followers'), [], `sin huecos de posts ni de seguidores: ${JSON.stringify(r.missingInputs)}`);
    assert.equal(r.cutHours, 168);
    assert.equal(r.brandFollowersGained, 800, '10 100 → 10 900 durante la campaña');
    assert.equal(r.codeRedemptions, 120);
    assert.equal(r.attributedRevenue, '2400000.00');
    assert.ok(Number(r.views ?? 0) > 0, `las vistas salen de las lecturas del recolector: ${JSON.stringify({ r, meta })}`);
  });

  test('9 · el reporte se genera, se envía y la marca lo abre sin sesión (CAM-6)', async () => {
    const r = await asLaura((tx) => generateReport(tx, cadena.campaignId!));
    await asLaura((tx) => markReportSent(tx, { campaignId: cadena.campaignId!, reportId: r.id, via: 'link' }, TEXTOS_REPORTE));
    cadena.reportId = r.id;
    cadena.reportSlug = r.slug;
    const publico = await web.withPublicShare((tx) => readPublicReport(tx, r.slug));
    assert.equal(publico.status, 'ok');
    if (publico.status !== 'ok') return;
    assert.equal(publico.report.company.name, 'Nutrivé');
    assert.equal((await asLaura((tx) => getCampaign(tx, cadena.campaignId!)))?.status, 'reported');
  });
});

describe('Finanzas: de la campaña al flujo de caja', () => {
  test('10 · la factura sale de la campaña con su nombre, su empresa y su monto (FIN-1)', async () => {
    const f = await asLaura((tx) => createInvoiceFromCampaign(tx, cadena.campaignId!));
    assert.equal(f.total, '7140000.00');
    assert.equal(f.companyId, cadena.companyId);
    cadena.invoiceId = f.id;
    cadena.invoiceNumber = f.number;
    assert.equal(f.status, 'draft');
    await asLaura((tx) => transitionInvoice(tx, f.id, 'sent'));
  });

  test('11 · un pago parcial y luego el total, con la reserva de impuestos (FIN-2)', async () => {
    const hoy = (await asLaura((tx) => getCashflowInputs(tx))).today;
    assert.equal(await asLaura((tx) => getReserveState(tx)), 'configurada', 'el seed trae el porcentaje de reserva (FIN-8)');
    const p1 = await asLaura((tx) => recordPayment(tx, { invoiceId: cadena.invoiceId!, amount: '3000000.00', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '0.00' }, TEXTOS_FIN));
    assert.ok(p1);
    assert.equal((await asLaura((tx) => getInvoice(tx, cadena.invoiceId!)))?.status, 'partial');
    await asLaura((tx) => recordPayment(tx, { invoiceId: cadena.invoiceId!, amount: '4140000.00', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '3000000.00' }, TEXTOS_FIN));
    assert.equal((await asLaura((tx) => getInvoice(tx, cadena.invoiceId!)))?.status, 'paid');
    // Cada pago aparta su impuesto: una fila de tax_reserve por pago, con monto × tasa redondeado a la mitad hacia arriba.
    const { rows: reservas } = await asLaura((tx) => tx.query<{ pagado: string; rate: string; amount: string }>(
      `SELECT p.amount::text AS pagado, r.rate::text AS rate, r.amount::text AS amount
         FROM tax_reserve r JOIN payment p ON p.id = r.payment_id WHERE p.invoice_id = $1 ORDER BY p.amount`, [cadena.invoiceId]));
    assert.equal(reservas.length, 2, 'una reserva por cada pago');
    for (const r of reservas) assert.equal(r.amount, mulRateHalfUp(r.pagado, r.rate), `reserva de ${r.pagado}`);
  });

  test('12 · el cobro por antigüedad la cuenta como pagada y no como pendiente (FIN-3)', async () => {
    const abiertas = (await asLaura((tx) => listReceivables(tx, { limit: 200 }))).rows.map((r) => r.id);
    const pagadas = (await asLaura((tx) => listReceivables(tx, { bucket: 'pagada', limit: 200 }))).rows.map((r) => r.id);
    assert.ok(!abiertas.includes(cadena.invoiceId!));
    assert.ok(pagadas.includes(cadena.invoiceId!));
    assert.ok(await asLaura((tx) => getReceivablesKpis(tx)));
  });

  test('13 · el flujo de caja suma el gasto nuevo y los ingresos de plataforma (FIN-5, FIN-6, FIN-7)', async () => {
    const cents = (d: string | null) => BigInt((d ?? '0.00').replace('.', ''));
    const antes = projectCashflow(await asLaura((tx) => getCashflowInputs(tx)));
    const hoy = (await asLaura((tx) => getCashflowInputs(tx))).today;
    const gasto = await asLaura((tx) => createExpense(tx, {
      category: 'software', vendor: 'Editor E2E', description: 'Licencia de edición', amount: '260000', incurredOn: hoy,
      isRecurring: true, recurrence: 'monthly', deductible: true,
    }));
    cadena.expenseId = gasto.id;
    const [adsense] = (await asLaura((tx) => listPayoutPlatforms(tx))).filter((x) => /youtube|adsense/i.test(x.name));
    assert.ok(adsense);
    const ultimo = ultimoMesCerrado(hoy);
    for (const k of [0, 1, 2]) {
      const mes = sumarMeses(`${ultimo}-01`, -k).slice(0, 7);
      const [anio, m] = mes.split('-').map(Number) as [number, number];
      const r = await asLaura((tx) => createPlatformPayout(tx, {
        platformId: adsense.id, periodStart: `${mes}-01`, periodEnd: `${mes}-${String(ultimoDiaDelMes(anio, m)).padStart(2, '0')}`,
        amount: '150000.00', currency: 'COP', source: 'manual',
      }));
      assert.ok(r.payout);
      cadena.payoutIds.push(r.payout.id);
    }
    const despues = projectCashflow(await asLaura((tx) => getCashflowInputs(tx)));
    assert.equal((cents(despues.gastoMensual) - cents(antes.gastoMensual)).toString(), '26000000', 'el gasto mensual sube exactamente 260 000');
    assert.equal((cents(despues.otrosIngresosMensual) - cents(antes.otrosIngresosMensual)).toString(), '15000000', 'AdSense suma 150 000 al mes');
    assert.ok(despues.otrosIngresosMensual !== null, 'con tres meses cerrados ya hay promedio (un nulo sería «sin datos», no cero)');
  });
});

describe('Accesos: bitácora y roles', () => {
  test('14 · la bitácora tiene una fila por cada escritura de cuenta, campaña, dinero y publicación', async () => {
    const { rows } = await web.queryAsSuperuser<{ action: string; entity_id: string | null; n: number }>(
      `SELECT action, entity_id::text, count(*)::int AS n FROM audit_log
        WHERE workspace_id = $1 AND created_at >= $2::timestamptz GROUP BY 1, 2`,
      [WORKSPACE_LAURA, inicio],
    );
    const n = (action: string, id: string | undefined) => rows.find((r) => r.action === action && r.entity_id === id)?.n ?? 0;
    const lista = JSON.stringify(rows);
    const c = cadena.campaignId;
    assert.equal(n('connection.added', connectionId), 1, lista);
    assert.equal(n('campaign.created', c), 1, lista);
    assert.equal(n('campaign.post_linked', c), 3, `tres videos asociados: ${lista}`);
    assert.equal(n('campaign.status_changed', c), 3, `live, measuring y reported: ${lista}`);
    assert.equal(n('campaign.report_sent', c), 1, lista);
    assert.equal(rows.filter((r) => r.action === 'campaign.brand_input.added').length, 2, `canjes e ingreso: ${lista}`);
    assert.equal(n('invoice.created', cadena.invoiceId), 1, lista);
    assert.equal(n('invoice.sent', cadena.invoiceId), 1, lista);
    assert.equal(n('invoice.payment_recorded', cadena.invoiceId), 2, `dos pagos: ${lista}`);
    assert.equal(n('expense.created', cadena.expenseId), 1, lista);
    for (const id of cadena.payoutIds) assert.equal(n('platform_payout.created', id), 1, lista);
  });

  test('15 · la Contadora ve Finanzas y no edita campañas; el Mánager edita campañas y no ve el flujo', async () => {
    const contadora = new Set(await asContadora(getSessionPermissions));
    const manager = new Set(await asManager(getSessionPermissions));
    assert.ok(contadora.has('finanzas.flujo.ver') && contadora.has('finanzas.pago.registrar'));
    assert.ok(!contadora.has('campanas.campana.editar'));
    assert.ok(manager.has('campanas.campana.editar') && manager.has('campanas.reporte.enviar'));
    assert.ok(!manager.has('finanzas.flujo.ver'));
    // Los dos ven la campaña de la cadena; ninguno la de otro workspace (RLS).
    assert.ok(await asContadora((tx) => getCampaign(tx, cadena.campaignId!)));
    assert.equal(await asManager((tx) => getCampaign(tx, CAMPAIGN_AJENA)), null);
    assert.equal(await asContadora((tx) => getCampaign(tx, CAMPAIGN_AJENA)), null);
  });

  test('16 · ningún secreto en la base tras la cadena entera: ni la API key en job_run, api_call_log ni la bitácora', async () => {
    // Como superusuario: el volcado mira TODAS las tablas, también las que mc_app no puede leer.
    const dump = await dumpTextColumns({ query: (text: string, params?: readonly unknown[]) => web.queryAsSuperuser(text, params) }, 'public');
    assert.equal(findSecretInDump(dump, [ENV.GOOGLE_API_KEY]), null);
    const runs = await worker.query<{ job_id: string; status: string }>(`SELECT job_id, status FROM job_run WHERE metadata->>'bossJobId' LIKE 'e2e:%' ORDER BY id`);
    assert.ok(runs.rows.length >= 6 && runs.rows.every((r) => r.status === 'ok'), `cada job de la cadena dejó su job_run ok: ${JSON.stringify(runs.rows)}`);
  });

  test('15b · el Mánager ve SOLO las campañas que tiene asignadas', { skip: 'ACC-6 (membership_scope y scope_allows, migración 0040) no está en main: sigue en la rama de la sesión de ACC' }, () => {});
});
