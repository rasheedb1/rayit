/**
 * ACC-6 · Alcance en queries/campanas.ts (y campanas/reporte.ts, que se
 * reexporta desde ahí): un miembro con alcance a Laura no ve las
 * campañas, los posts, los aportes de la marca, el resultado, los
 * seguidores de la marca ni los reportes de Sofía en NINGUNA función
 * exportada, y ninguna escritura suya toca lo de Sofía. Ver test/alcance.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularResultado } from '@mc/core';
import * as campanas from '../src/queries/campanas.ts';
import { ScopeError } from '../src/scope.ts';
import { CAMPAIGN_CAFE_ALMA, CAMPAIGN_FRESKO, COMPANY_CAFE_ALMA, POST_D03_TIKTOK_FRESKO, WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import {
  CAMPAIGN_LAURA_PRUEBA, CAMPAIGN_SOFIA, CREATOR_LAURA, CREATOR_SOFIA, definirPruebasDeAlcance, EMPRESA_SOFIA, POST_SOFIA, QUOTE_SOFIA,
  USER_MIEMBRO_CAMPANA, USER_MIEMBRO_MARCA, type CasoDeAlcance,
} from './alcance.ts';

const {
  listCampaigns, getCampaign, listCampaignPosts, listLinkablePosts, suggestPosts, linkPost, setPrimaryPost, unlinkPost,
  updateCampaign, transitionCampaign, createCampaignFromQuote, addBrandInput, openBrandCsvImport, importBrandCsv, listBrandInputs,
  getResultInputs, upsertResult, computeCampaignResult, getCampaignResult, canRecomputeResult, listBrandFollowers,
  brandPlatformsReadOn, recordBrandSnapshot, listCampaignReports, getReport, generateReport, markReportSent,
  CampaignNotFoundError, CampaignPostNotFoundError, PostNotFoundError, QuoteNotFoundError, ReportNotFoundError,
} = campanas;

/** Lo de Sofía que solo usa Campañas (prefijo 0000000a-…). */
const REPORT_SOFIA = '0000000a-0000-4000-8000-00000e900001';
const BRAND_INPUT_SOFIA = '0000000a-0000-4000-8000-0000b1a00001';
const DIA_MARCA_SOFIA = '2026-08-15';

/** Un resultado cualquiera para upsertResult: el de una campaña sin datos. */
const VALORES = calcularResultado({
  amount: null, currency: 'COP', startsOn: null, endsOn: null, brandBaselineFrom: null,
  posts: [], baselines: [], brandSeries: [], brandTotals: [],
});

const TEXTOS: campanas.TextosReporte = {
  actividadEnviado: ({ campaignName, via }) => `[reporte:${via}] ${campaignName}`,
  avisoEnviado: ({ companyName, campaignName, via }) => ({ title: `[aviso] ${companyName}`, body: `${campaignName} · ${via}` }),
};

/**
 * Las filas de Sofía en las tablas de Campañas que la huella común no
 * mira. Se toma al sembrar y se compara después de la pasada del miembro.
 */
async function huellaCampanas(t: TestDb): Promise<Record<string, string | null>> {
  const tablas: Record<string, string> = {
    campaign_brand_input: `SELECT x.* FROM campaign_brand_input x WHERE x.campaign_id = '${CAMPAIGN_SOFIA}'`,
    campaign_result: `SELECT x.* FROM campaign_result x WHERE x.campaign_id = '${CAMPAIGN_SOFIA}'`,
    report: `SELECT x.* FROM report x WHERE x.campaign_id = '${CAMPAIGN_SOFIA}'`,
    brand_account_snapshot: `SELECT x.* FROM brand_account_snapshot x WHERE x.campaign_id = '${CAMPAIGN_SOFIA}'`,
  };
  const out: Record<string, string | null> = {};
  for (const [tabla, sql] of Object.entries(tablas)) {
    const [fila] = await t.raw<{ h: string | null }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM (${sql}) x`);
    out[tabla] = fila?.h ?? null;
  }
  return out;
}

let antesCampanas: Record<string, string | null>;

/** Aportes, resultado, reporte en borrador y seguidores de la marca de Sofía. Idempotente. */
async function sembrarCampanas(t: TestDb): Promise<void> {
  await t.admin(`
    UPDATE campaign SET brand_accounts = '[{"platform_id": "instagram", "handle": "marcasofia"}]'::jsonb
     WHERE id = '${CAMPAIGN_SOFIA}';
    INSERT INTO campaign_brand_input (id, workspace_id, campaign_id, kind, day, value_num, currency, source)
    VALUES ('${BRAND_INPUT_SOFIA}', '${WORKSPACE_LAURA}', '${CAMPAIGN_SOFIA}', 'orders', DATE '${DIA_MARCA_SOFIA}', 12, NULL, 'brand_manual')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign_result (campaign_id, workspace_id, cut_hours, views)
    VALUES ('${CAMPAIGN_SOFIA}', '${WORKSPACE_LAURA}', 720, 88000)
    ON CONFLICT DO NOTHING;
    INSERT INTO report (id, workspace_id, campaign_id, company_id, kind, slug, payload, status)
    VALUES ('${REPORT_SOFIA}', '${WORKSPACE_LAURA}', '${CAMPAIGN_SOFIA}', '${EMPRESA_SOFIA}', 'campaign', 'rep-sofia-901', '{}'::jsonb, 'draft')
    ON CONFLICT DO NOTHING;
    INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, handle, day, followers, source)
    SELECT '${CAMPAIGN_SOFIA}', '${EMPRESA_SOFIA}', 'instagram', 'marcasofia', DATE '${DIA_MARCA_SOFIA}', 5000, 'business_discovery'
    WHERE NOT EXISTS (SELECT 1 FROM brand_account_snapshot WHERE campaign_id = '${CAMPAIGN_SOFIA}');
  `);
  antesCampanas = await huellaCampanas(t);
}

/**
 * En orden: lecturas, luego escrituras (la pasada de control de la dueña
 * las ejecuta de verdad, en este orden: transitionCampaign pone la
 * campaña de Sofía en live antes de computeCampaignResult y generateReport).
 */
const CASOS: Record<string, CasoDeAlcance> = {
  listCampaigns: { run: (tx) => listCampaigns(tx), duena: 'nombra', miembro: 'nada' },
  getCampaign: { run: (tx) => getCampaign(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  listCampaignPosts: { run: (tx) => listCampaignPosts(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Desde una campaña de Laura: el post de Sofía es asociable para la dueña, invisible para el miembro.
  listLinkablePosts: { run: (tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA, q: 'playa' }), duena: 'nombra', miembro: 'nada' },
  // El post de Sofía menciona a @cafealma dentro de la ventana de Café Alma: la dueña lo ve sugerido.
  suggestPosts: { run: (tx) => suggestPosts(tx, CAMPAIGN_CAFE_ALMA), duena: 'nombra', miembro: 'nada' },
  listBrandInputs: {
    run: (tx) => listBrandInputs(tx, CAMPAIGN_SOFIA),
    duena: (r) => (r as campanas.BrandInputs).totals.some((x) => x.kind === 'orders'),
    miembro: { rechaza: CampaignNotFoundError },
  },
  getResultInputs: { run: (tx) => getResultInputs(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  getCampaignResult: { run: (tx) => getCampaignResult(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Sin filtro: pregunta por un privilegio del rol, no lee filas de nadie.
  canRecomputeResult: { run: (tx) => canRecomputeResult(tx), duena: 'pasa', miembro: 'nada' },
  listBrandFollowers: { run: (tx) => listBrandFollowers(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Devuelve redes, no ids: la prueba extra exige la lista vacía al miembro.
  brandPlatformsReadOn: {
    run: (tx) => brandPlatformsReadOn(tx, CAMPAIGN_SOFIA, DIA_MARCA_SOFIA),
    duena: (r) => Array.isArray(r) && r.includes('instagram'),
    miembro: 'nada',
  },
  listCampaignReports: { run: (tx) => listCampaignReports(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  getReport: { run: (tx) => getReport(tx, REPORT_SOFIA), duena: 'nombra', miembro: 'nada' },

  // Campaña de Laura + post de Sofía: para el miembro, el post no existe.
  linkPost: { run: (tx) => linkPost(tx, { campaignId: CAMPAIGN_LAURA_PRUEBA, postId: POST_SOFIA }), duena: 'nombra', miembro: { rechaza: PostNotFoundError } },
  setPrimaryPost: { run: (tx) => setPrimaryPost(tx, CAMPAIGN_SOFIA, POST_SOFIA), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  unlinkPost: { run: (tx) => unlinkPost(tx, CAMPAIGN_SOFIA, POST_SOFIA), duena: (r) => r === true, miembro: { rechaza: CampaignNotFoundError } },
  updateCampaign: { run: (tx) => updateCampaign(tx, CAMPAIGN_SOFIA, { name: 'Renombrada' }), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  addBrandInput: {
    run: (tx) => addBrandInput(tx, { campaignId: CAMPAIGN_SOFIA, kind: 'orders', day: '2026-08-16', value: '20' }),
    duena: (r) => (r as campanas.AddBrandInputResult).created,
    miembro: { rechaza: CampaignNotFoundError },
  },
  openBrandCsvImport: { run: (tx) => openBrandCsvImport(tx, CAMPAIGN_SOFIA), duena: 'pasa', miembro: { rechaza: CampaignNotFoundError } },
  importBrandCsv: {
    run: (tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_SOFIA, rows: [{ line: 2, day: '2026-08-12', sales: '150000.00', orders: 3, redemptions: null }] }),
    duena: (r) => (r as campanas.ImportBrandCsvResult).inserted > 0,
    miembro: { rechaza: CampaignNotFoundError },
  },
  recordBrandSnapshot: {
    run: (tx) => recordBrandSnapshot(tx, {
      campaignId: CAMPAIGN_SOFIA, companyId: EMPRESA_SOFIA, platformId: 'instagram', day: '2026-08-16', handle: 'marcasofia',
      externalAccountId: null, followers: 5100, mediaCount: null, source: 'instagram.business_discovery',
    }),
    duena: (r) => r === 'guardada',
    miembro: { rechaza: CampaignNotFoundError },
  },
  // Devuelve un booleano: la huella de Campañas (prueba extra) demuestra que el miembro no escribió.
  upsertResult: { run: (tx) => upsertResult(tx, CAMPAIGN_SOFIA, VALORES, null), duena: (r) => r === true, miembro: 'nada' },
  transitionCampaign: { run: (tx) => transitionCampaign(tx, CAMPAIGN_SOFIA, 'live'), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  computeCampaignResult: { run: (tx) => computeCampaignResult(tx, CAMPAIGN_SOFIA), duena: (r) => r !== null, miembro: 'nada' },
  generateReport: { run: (tx) => generateReport(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  markReportSent: {
    run: (tx) => markReportSent(tx, { campaignId: CAMPAIGN_SOFIA, reportId: REPORT_SOFIA, via: 'link' }, TEXTOS),
    duena: 'nombra',
    miembro: { rechaza: ReportNotFoundError },
  },
  createCampaignFromQuote: {
    run: (tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SOFIA, startsOn: '2026-11-03', endsOn: '2026-11-10' }),
    duena: 'nombra',
    miembro: { rechaza: QuoteNotFoundError },
  },

  // Puras: no consultan la base.
  brandAccountsOf: 'pura',
  brandNoDataReasonFor: 'pura',
  isBrandSnapshotDue: 'pura',
  // Solo worker (mc_worker, sin persona ni alcance): apps/worker/src/jobs/campanas/campaign-compute.ts.
  listCampaignsToCompute: 'pura',
  // Sin alcance por diseño: la lectura pública por slug (PublicShareTx, sin sesión ni persona), campanas/reporte-publico.ts.
  readPublicReport: 'pura',
};

/** Una cotización aceptada de Laura cuya campaña viva quedó reasignada a Sofía. */
const QUOTE_LAURA_REASIGNADA = '0000000b-0000-4000-8000-0000c0700001';
const CAMPAIGN_REASIGNADA = '0000000b-0000-4000-8000-000000ca0002';

definirPruebasDeAlcance('campanas', campanas, CASOS, ({ t, duena, miembro, como }) => {
  test('la pasada del miembro no dejó fila en aportes, resultado, reportes ni seguidores de la marca de Sofía', async () => {
    assert.deepEqual(await huellaCampanas(t()), antesCampanas);
  });

  test('lo que devuelve redes o cifras y no ids: el miembro recibe vacío o null', async () => {
    assert.deepEqual(await miembro((tx) => brandPlatformsReadOn(tx, CAMPAIGN_SOFIA, DIA_MARCA_SOFIA)), []);
    assert.equal(await miembro((tx) => upsertResult(tx, CAMPAIGN_SOFIA, VALORES, null)), false, 'ni INSERT ni rama ON CONFLICT');
    // Con la campaña de Sofía en live, recalcular sería posible: para el miembro no existe.
    await t().admin(`UPDATE campaign SET status = 'live' WHERE id = '${CAMPAIGN_SOFIA}'`);
    try {
      assert.equal(await miembro((tx) => getResultInputs(tx, CAMPAIGN_SOFIA)), null);
      assert.equal(await miembro((tx) => computeCampaignResult(tx, CAMPAIGN_SOFIA)), null);
    } finally {
      await t().admin(`UPDATE campaign SET status = 'planned' WHERE id = '${CAMPAIGN_SOFIA}'`);
    }
    assert.deepEqual(await huellaCampanas(t()), antesCampanas);
  });

  test('reportes por alcance de MARCA y de CAMPAÑA: los de su campaña sí, los de otra no', async () => {
    const deLaMarca = await como(USER_MIEMBRO_MARCA, (tx) => listCampaignReports(tx, CAMPAIGN_SOFIA));
    assert.deepEqual(deLaMarca.map((r) => r.id), [REPORT_SOFIA]);
    assert.equal((await como(USER_MIEMBRO_MARCA, (tx) => getReport(tx, REPORT_SOFIA)))?.campaignId, CAMPAIGN_SOFIA);
    assert.deepEqual(await como(USER_MIEMBRO_CAMPANA, (tx) => listCampaignReports(tx, CAMPAIGN_SOFIA)), []);
    assert.equal(await como(USER_MIEMBRO_CAMPANA, (tx) => getReport(tx, REPORT_SOFIA)), null);
    assert.equal(await como(USER_MIEMBRO_CAMPANA, (tx) => getCampaignResult(tx, CAMPAIGN_SOFIA)), null);
    await assert.rejects(como(USER_MIEMBRO_CAMPANA, (tx) => listBrandInputs(tx, CAMPAIGN_SOFIA)), CampaignNotFoundError);
    assert.ok((await como(USER_MIEMBRO_MARCA, (tx) => listBrandInputs(tx, CAMPAIGN_SOFIA))).totals.length > 0);
  });

  test('la campaña viva de una cotización del alcance quedó fuera del alcance: ScopeError, no un choque con el índice único', async () => {
    await t().admin(`
      INSERT INTO quote (id, workspace_id, company_id, creator_id, number, slug, currency, subtotal, tax, total,
                         agreed_metrics, report_cuts_hours, payment_terms_days, status)
      VALUES ('${QUOTE_LAURA_REASIGNADA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${CREATOR_LAURA}', 'COT-2026-902', 'cot-laura-902', 'COP',
              1000000.00, 190000.00, 1190000.00, '{views}', '{168}', 30, 'accepted')
      ON CONFLICT DO NOTHING;
      INSERT INTO campaign (id, workspace_id, company_id, creator_id, quote_id, name, status)
      VALUES ('${CAMPAIGN_REASIGNADA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${CREATOR_SOFIA}', '${QUOTE_LAURA_REASIGNADA}', 'Reasignada a Sofía', 'planned')
      ON CONFLICT DO NOTHING;
    `);
    await assert.rejects(
      miembro((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_LAURA_REASIGNADA, startsOn: '2026-11-03', endsOn: '2026-11-10' })),
      ScopeError,
    );
    const r = await duena((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_LAURA_REASIGNADA, startsOn: '2026-11-03', endsOn: '2026-11-10' }));
    assert.deepEqual([r.created, r.campaign.id], [false, CAMPAIGN_REASIGNADA], 'la dueña la ve: idempotente como siempre');
    await t().admin(`DELETE FROM campaign WHERE id = '${CAMPAIGN_REASIGNADA}'; DELETE FROM quote WHERE id = '${QUOTE_LAURA_REASIGNADA}';`);
  });

  test('el miembro sigue viendo TODO lo de Laura: la lista es la de la dueña menos lo de Sofía', async () => {
    const todas = await duena((tx) => listCampaigns(tx));
    const suyas = await miembro((tx) => listCampaigns(tx));
    assert.deepEqual(
      suyas.map((c) => c.id).sort(),
      todas.filter((c) => c.id !== CAMPAIGN_SOFIA).map((c) => c.id).sort(),
    );
    assert.ok(suyas.length >= 5, 'las cuatro del seed y la de prueba');
    const ficha = await miembro((tx) => getCampaign(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(ficha?.postsCount, 2);
  });

  test('un post de Sofía asociado a una campaña de Laura: la dueña lo ve y lo cuenta; el miembro no, ni en la ficha ni en la lista', async () => {
    await duena((tx) => linkPost(tx, { campaignId: CAMPAIGN_LAURA_PRUEBA, postId: POST_SOFIA, deliverable: 'invitada' }));
    try {
      const deLaDuena = await duena((tx) => listCampaignPosts(tx, CAMPAIGN_LAURA_PRUEBA));
      assert.deepEqual(deLaDuena.map((p) => p.postId), [POST_SOFIA]);
      assert.equal((await duena((tx) => listCampaigns(tx))).find((c) => c.id === CAMPAIGN_LAURA_PRUEBA)?.postsCount, 1);

      assert.deepEqual(await miembro((tx) => listCampaignPosts(tx, CAMPAIGN_LAURA_PRUEBA)), []);
      const fila = (await miembro((tx) => listCampaigns(tx))).find((c) => c.id === CAMPAIGN_LAURA_PRUEBA);
      assert.equal(fila?.postsCount, 0, 'la lista no cuenta lo que la ficha no enseña');
      assert.equal(fila?.viewsTotal, null, 'sin posts visibles no hay views: null, no cero');
      const ficha = await miembro((tx) => getCampaign(tx, CAMPAIGN_LAURA_PRUEBA));
      assert.deepEqual(ficha?.deliverables, [], 'los entregables tampoco cuentan el post que no ve');
      // Y no puede marcarlo principal ni quitarlo, porque para él no está.
      await assert.rejects(miembro((tx) => setPrimaryPost(tx, CAMPAIGN_LAURA_PRUEBA, POST_SOFIA)), CampaignPostNotFoundError);
      assert.equal((await duena((tx) => listCampaignPosts(tx, CAMPAIGN_LAURA_PRUEBA))).length, 1, 'sigue asociado');
    } finally {
      await duena((tx) => unlinkPost(tx, CAMPAIGN_LAURA_PRUEBA, POST_SOFIA));
    }
  });

  test('alcance por CAMPAÑA: solo esa campaña y sus posts; crear una campaña desde una cotización queda fuera', async () => {
    const lista = await como(USER_MIEMBRO_CAMPANA, (tx) => listCampaigns(tx));
    assert.deepEqual(lista.map((c) => c.id), [CAMPAIGN_CAFE_ALMA]);
    assert.equal(await como(USER_MIEMBRO_CAMPANA, (tx) => getCampaign(tx, CAMPAIGN_FRESKO)), null);
    assert.equal((await como(USER_MIEMBRO_CAMPANA, (tx) => listCampaignPosts(tx, CAMPAIGN_CAFE_ALMA))).length, 2, 'los posts de su campaña sí');
    assert.deepEqual(await como(USER_MIEMBRO_CAMPANA, (tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO)), []);
    // Un post que solo cuelga de otra campaña no es asociable: no hay camino a su alcance.
    const asociables = await como(USER_MIEMBRO_CAMPANA, (tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA, q: 'fresko' }));
    assert.ok(!asociables.some((p) => p.postId === POST_D03_TIKTOK_FRESKO));
    await assert.rejects(
      como(USER_MIEMBRO_CAMPANA, (tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SOFIA, startsOn: '2026-11-03', endsOn: '2026-11-10' })),
      QuoteNotFoundError,
      'una campaña nueva no cabe en «esa campaña»',
    );
  });

  test('alcance por MARCA: las campañas de esa marca y sus posts, por el camino campaign_post → campaign', async () => {
    const lista = await como(USER_MIEMBRO_MARCA, (tx) => listCampaigns(tx));
    assert.deepEqual(lista.map((c) => c.id), [CAMPAIGN_SOFIA], 've la de Sofía, no las de Laura con otras marcas');
    const posts = await como(USER_MIEMBRO_MARCA, (tx) => listCampaignPosts(tx, CAMPAIGN_SOFIA));
    assert.deepEqual(posts.map((p) => p.postId), [POST_SOFIA]);
    assert.equal((await como(USER_MIEMBRO_MARCA, (tx) => getCampaign(tx, CAMPAIGN_SOFIA)))?.creatorId, CREATOR_SOFIA);
    assert.equal(await como(USER_MIEMBRO_MARCA, (tx) => getCampaign(tx, CAMPAIGN_CAFE_ALMA)), null);
  });
}, sembrarCampanas);
