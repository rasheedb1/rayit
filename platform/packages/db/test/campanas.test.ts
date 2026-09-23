import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignLockedError, InvalidCampaignTransition, InvalidDatesError, InvalidNameError } from '@mc/core';
import {
  getCampaign,
  linkPost,
  listCampaignPosts,
  listCampaigns,
  listLinkablePosts,
  setPrimaryPost,
  suggestPosts,
  transitionCampaign,
  unlinkPost,
  updateCampaign,
  CampaignNotFoundError,
  CampaignPostNotFoundError,
  PostNotFoundError,
  QuoteNotAcceptedError,
  QuoteNotFoundError,
  createCampaignFromQuote,
  addBrandInput,
  importBrandCsv,
  listBrandInputs,
  BrandCsvOutOfWindowError,
  CampaignWithoutDatesError,
  openBrandCsvImport,
  InvalidBrandInputError,
  type WorkspaceTx,
} from '../src/index.ts';
import {
  openTestDb, type TestDb,
  WORKSPACE_LAURA, COMPANY_CAFE_ALMA, CAMPAIGN_CAFE_ALMA, CAMPAIGN_FRESKO, CAMPAIGN_NUTRIVE, CAMPAIGN_HOGAR_LINDO,
  POST_D01_REEL_CAFE_ALMA, POST_D02_TIKTOK_CAFE_ALMA, POST_D03_TIKTOK_FRESKO, POST_D04_TIKTOK_FRESKO, POST_D05_YOUTUBE_NUTRIVE,
} from './pglite.ts';

/** Un workspace ajeno con una campaña propia, para las pruebas de aislamiento. */
const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000001';
const CAMPAIGN_AJENA = '00000009-0000-4000-8000-0000000ca001';
/** Su propia ficha de la marca: el mismo dominio que la de Laura, sin chocar (0025 §2). */
const EMPRESA_AJENA = '00000009-0000-4000-8000-0000000000e1';
/** Una campaña nueva de Laura, en planned, para las transiciones. */
const CAMPAIGN_PRUEBA = '00000003-0000-4000-8000-00000ca0f001';
/** Otra de Laura, sin fechas: no puede importar un CSV de ventas (CAM-4). */
const CAMPAIGN_SIN_FECHAS = '00000003-0000-4000-8000-00000ca0f002';

let t: TestDb;
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);

before(async () => {
  t = await openTestDb();
  // Como superusuario (sin RLS): el workspace ajeno y su campaña. La
  // campaña apunta a SU ficha de Café Alma, no a la de Laura: desde
  // 0025 una empresa con dueño solo la lee su dueño, y ningún workspace
  // puede nombrar en sus filas una empresa que no lee (§3). Antes
  // apuntaba a la de Laura «porque company no tenía workspace», que es
  // justo la puerta lateral que 0025 cierra.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno-campanas', 'Workspace ajeno', 'creator', 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO company (id, name, domain, owner_workspace_id)
    VALUES ('${EMPRESA_AJENA}', 'Café Alma', 'cafealma.co', '${WORKSPACE_AJENO}')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on)
    VALUES ('${CAMPAIGN_AJENA}', '${WORKSPACE_AJENO}', '${EMPRESA_AJENA}', 'Campaña ajena', 'planned', DATE '2026-08-24', DATE '2026-08-31')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, amount, currency)
    VALUES ('${CAMPAIGN_PRUEBA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', 'Campaña de prueba', 'planned', DATE '2026-10-01', DATE '2026-10-08', 1000000.00, 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, amount, currency)
    VALUES ('${CAMPAIGN_SIN_FECHAS}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', 'Campaña sin fechas', 'planned', 500000.00, 'COP')
    ON CONFLICT DO NOTHING;
  `);
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

/**
 * Las views que enseñan la lista y la ficha son la ÚLTIMA lectura de
 * cada video, y el seed 0002 sigue midiendo la curva de todos hasta los
 * 90 días: el número exacto sube cada día que pasa. Clavarlo aquí sería
 * una prueba que falla sola mañana sin que nadie toque el código.
 *
 * Lo que no se mueve es la cifra del mock —la lectura a 720 h, que es
 * la que citan el reporte y la factura— y el margen en el que la curva
 * puede estar respecto a ella: como mucho un 3 % por encima (su techo,
 * porque el denominador de la curva vale 0,9752 a 720 h) y no más de un
 * 5 % por debajo mientras el video aún no cumple los 30 días. Fuera de
 * esa banda ya no es el paso del tiempo: es una regresión.
 */
function cercaDelMock(actual: number | null | undefined, ref: number, que: string): asserts actual is number {
  assert.ok(
    typeof actual === 'number' && actual >= Math.round(ref * 0.95) && actual <= Math.round(ref * 1.03),
    `${que}: ${actual} debería estar a menos del 5 % de la cifra del mock (${ref})`,
  );
}

/** La curva de 0002 llega hasta ayer: la última lectura es de las últimas 48 h. */
const lecturaReciente = (iso: string | null | undefined, que: string) => {
  assert.ok(typeof iso === 'string', `${que}: debería haber una lectura, no ${iso}`);
  const horas = (Date.now() - Date.parse(iso as string)) / 3_600_000;
  assert.ok(horas >= 0 && horas < 48, `${que}: la última lectura (${iso}) debería ser de las últimas 48 h`);
};

describe('lista y ficha', () => {
  test('la lista da las cuatro campañas del mock con sus cifras', async () => {
    const rows = await laura((tx) => listCampaigns(tx));
    const seed = rows.filter((r) => r.id !== CAMPAIGN_PRUEBA && r.id !== CAMPAIGN_SIN_FECHAS);
    assert.deepEqual(
      seed.map((r) => [r.companyName, r.status, r.postsCount, r.amount, r.hasInvoice]),
      [
        ['Fresko Market', 'measuring', 2, '5200000.00', true],
        ['Café Alma', 'reported', 2, '3100000.00', true],
        ['Nutrivé', 'closed', 1, '4700000.00', true],
        ['Hogar Lindo', 'reported', 0, '1100000.00', true],
      ],
      'más recientes primero',
    );
    cercaDelMock(seed[0]?.viewsTotal, 140000 + 125000, 'Fresko Market');
    cercaDelMock(seed[1]?.viewsTotal, 412000 + 300000, 'Café Alma');
    cercaDelMock(seed[2]?.viewsTotal, 58000, 'Nutrivé');
    assert.equal(seed[3]?.viewsTotal, null, 'sin posts no hay views: null, no cero');
    const cafe = rows.find((r) => r.id === CAMPAIGN_CAFE_ALMA);
    lecturaReciente(cafe?.dataAsOf, 'Café Alma');
    assert.equal(cafe?.startsOn, '2026-08-10');
    assert.equal(cafe?.endsOn, '2026-08-17');
    assert.equal(rows.find((r) => r.id === CAMPAIGN_HOGAR_LINDO)?.dataAsOf, null);
    assert.equal(rows.find((r) => r.id === CAMPAIGN_PRUEBA)?.hasInvoice, false);
  });

  test('filtro por estado', async () => {
    const reported = await laura((tx) => listCampaigns(tx, { status: 'reported' }));
    assert.deepEqual(reported.map((r) => r.companyName), ['Café Alma', 'Hogar Lindo']);
    const varios = await laura((tx) => listCampaigns(tx, { status: ['closed', 'measuring'] }));
    assert.deepEqual(varios.map((r) => r.companyName), ['Fresko Market', 'Nutrivé']);
  });

  test('la ficha de Café Alma: con su cotización del seed 0004, entregables desde ella, factura enlazada', async () => {
    const c = await laura((tx) => getCampaign(tx, CAMPAIGN_CAFE_ALMA));
    assert.ok(c);
    assert.equal(c.name, 'Lanzamiento cold brew');
    assert.equal(c.trackingCode, 'LAURA15');
    assert.match(c.trackingUrl ?? '', /^https:\/\/cafealma\.co\//);
    assert.deepEqual(c.utm, { utm_source: 'instagram', utm_medium: 'creator', utm_campaign: 'laura_coldbrew' });
    assert.equal(c.brandBaselineFrom, '2026-07-27');
    // El seed 0004 la enlaza a la cotización que la originó (COT-2026-003):
    // lo acordado y los entregables salen de ahí, como en una creada con
    // createCampaignFromQuote.
    assert.equal(c.agreed?.quoteNumber, 'COT-2026-003');
    assert.equal(c.agreed?.quoteStatus, 'accepted');
    assert.equal(c.deliverablesSource, 'quote');
    assert.deepEqual(c.deliverables.map((d) => [d.deliverable, d.quantity]), [['reel', 1], ['tiktok', 1], ['historias', 1]]);
    assert.deepEqual(c.invoices.map((i) => [i.number, i.status, i.total]), [['FV-2026-010', 'sent', '3100000.00']]);
    cercaDelMock(c.viewsTotal, 412000 + 300000, 'la ficha de Café Alma');
    assert.equal(await laura((tx) => getCampaign(tx, '00000003-0000-4000-8000-000000000000')), null);
  });

  test('los posts de Café Alma: dos, 412 K + 300 K, el principal primero, con datos hasta', async () => {
    const posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_CAFE_ALMA));
    assert.deepEqual(
      posts.map((p) => [p.postId, p.platformId, p.isPrimary, p.deliverable]),
      [
        [POST_D01_REEL_CAFE_ALMA, 'instagram', true, 'reel'],
        [POST_D02_TIKTOK_CAFE_ALMA, 'tiktok', false, 'tiktok'],
      ],
    );
    cercaDelMock(posts[0]?.views, 412000, 'el reel de Café Alma');
    cercaDelMock(posts[1]?.views, 300000, 'el TikTok de Café Alma');
    cercaDelMock(posts[0]?.reach, 296000, 'el alcance del reel');
    cercaDelMock(posts[0]?.saves, 6200, 'los guardados del reel');
    lecturaReciente(posts[0]?.dataAsOf, 'el reel de Café Alma');
    assert.equal(posts[0]?.publishedAt, '2026-08-10T17:00:00Z');
    lecturaReciente(posts[1]?.dataAsOf, 'el TikTok de Café Alma');
  });
});

describe('asociar y quitar posts', () => {
  test('asociar a Fresko un post que no es suyo y quitarlo; asociar dos veces no duplica', async () => {
    const antes = (await laura((tx) => listCampaigns(tx, { status: 'measuring' })))[0]?.viewsTotal ?? 0;
    const linked = await laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_FRESKO, postId: POST_D05_YOUTUBE_NUTRIVE, deliverable: 'dedicado' }));
    assert.equal(linked.postId, POST_D05_YOUTUBE_NUTRIVE);
    cercaDelMock(linked.views, 58000, 'el video de Nutrivé, con sus views actuales');
    assert.equal(linked.deliverable, 'dedicado');
    assert.equal(linked.isPrimary, false);

    let posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO));
    assert.equal(posts.length, 3);
    const lista = await laura((tx) => listCampaigns(tx, { status: 'measuring' }));
    assert.equal(lista[0]?.viewsTotal, antes + linked.views, 'la lista suma el post nuevo');

    const otraVez = await laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_FRESKO, postId: POST_D05_YOUTUBE_NUTRIVE }));
    assert.equal(otraVez.deliverable, 'dedicado', 'sin deliverable conserva el anterior');
    posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO));
    assert.equal(posts.length, 3, 'no duplica');

    assert.equal(await laura((tx) => unlinkPost(tx, CAMPAIGN_FRESKO, POST_D05_YOUTUBE_NUTRIVE)), true);
    assert.equal(await laura((tx) => unlinkPost(tx, CAMPAIGN_FRESKO, POST_D05_YOUTUBE_NUTRIVE)), false, 'ya no estaba');
    posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO));
    assert.equal(posts.length, 2);
    assert.equal((await laura((tx) => listCampaignPosts(tx, CAMPAIGN_NUTRIVE))).length, 1, 'el post sigue en Nutrivé');
  });

  test('un solo principal por campaña', async () => {
    const linked = await laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_FRESKO, postId: POST_D05_YOUTUBE_NUTRIVE, isPrimary: true }));
    assert.equal(linked.isPrimary, true);
    let posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(posts.filter((p) => p.isPrimary).map((p) => p.postId), [POST_D05_YOUTUBE_NUTRIVE]);

    const back = await laura((tx) => setPrimaryPost(tx, CAMPAIGN_FRESKO, POST_D03_TIKTOK_FRESKO));
    assert.equal(back.isPrimary, true);
    posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(posts.filter((p) => p.isPrimary).map((p) => p.postId), [POST_D03_TIKTOK_FRESKO]);
    assert.equal(posts[0]?.postId, POST_D03_TIKTOK_FRESKO, 'el principal va primero');

    await assert.rejects(laura((tx) => setPrimaryPost(tx, CAMPAIGN_FRESKO, POST_D01_REEL_CAFE_ALMA)), CampaignPostNotFoundError);
    await laura((tx) => unlinkPost(tx, CAMPAIGN_FRESKO, POST_D05_YOUTUBE_NUTRIVE));
  });

  test('un post o una campaña de otro workspace no se pueden asociar', async () => {
    // Desde el workspace ajeno, la campaña de Laura no existe.
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => linkPost(tx, { campaignId: CAMPAIGN_CAFE_ALMA, postId: POST_D05_YOUTUBE_NUTRIVE })),
      CampaignNotFoundError,
    );
    // Desde el workspace ajeno, su campaña existe pero el post de Laura no.
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => linkPost(tx, { campaignId: CAMPAIGN_AJENA, postId: POST_D01_REEL_CAFE_ALMA })),
      PostNotFoundError,
    );
    // Desde Laura, la campaña ajena no existe.
    await assert.rejects(laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_AJENA, postId: POST_D01_REEL_CAFE_ALMA })), CampaignNotFoundError);
    await assert.rejects(laura((tx) => unlinkPost(tx, CAMPAIGN_AJENA, POST_D01_REEL_CAFE_ALMA)), CampaignNotFoundError);
    assert.equal(await laura((tx) => getCampaign(tx, CAMPAIGN_AJENA)), null);
    assert.deepEqual(await laura((tx) => listCampaignPosts(tx, CAMPAIGN_AJENA)), []);

    // Y el ajeno solo ve lo suyo: una campaña sin posts, ningún post asociable.
    const ajenas = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listCampaigns(tx));
    assert.deepEqual(ajenas.map((c) => c.id), [CAMPAIGN_AJENA]);
    assert.deepEqual(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_AJENA })), []);
    assert.deepEqual(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => suggestPosts(tx, CAMPAIGN_AJENA)), []);
    // Nada cambió en campaign_post.
    assert.equal((await laura((tx) => listCampaignPosts(tx, CAMPAIGN_CAFE_ALMA))).length, 2);
  });
});

describe('buscar y sugerir', () => {
  test('posts asociables: los que no están en la campaña, buscables por caption con comodines escapados', async () => {
    const todos = await laura((tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA }));
    // Con el seed 0002 la parrilla de Laura tiene decenas de videos, así
    // que la lista completa ya no se puede clavar entera. Lo que sí se
    // afirma es lo que la consulta promete: los dos que YA están en la
    // campaña no aparecen, los de las otras campañas sí, y el orden es
    // por fecha de publicación descendente.
    const ids = todos.map((p) => p.postId);
    assert.ok(!ids.includes(POST_D01_REEL_CAFE_ALMA) && !ids.includes(POST_D02_TIKTOK_CAFE_ALMA), 'los suyos no se ofrecen');
    for (const id of [POST_D04_TIKTOK_FRESKO, POST_D03_TIKTOK_FRESKO, POST_D05_YOUTUBE_NUTRIVE]) {
      assert.ok(ids.includes(id), `${id} debería poder asociarse`);
    }
    const fechas = todos.map((p) => p.publishedAt);
    assert.deepEqual(fechas, [...fechas].sort().reverse(), 'más recientes primero');
    const fresko = await laura((tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA, q: 'FRESKO' }));
    assert.deepEqual(fresko.map((p) => p.postId), [POST_D04_TIKTOK_FRESKO, POST_D03_TIKTOK_FRESKO]);
    cercaDelMock(fresko[0]?.views, 125000, 'el segundo TikTok de Fresko');
    assert.deepEqual(await laura((tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA, q: '%' })), [], 'el comodín se busca literal');
    await assert.rejects(laura((tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_AJENA })), CampaignNotFoundError);
  });

  test('las sugerencias para Café Alma encuentran sus posts por mención o código, y no los de Nutrivé', async () => {
    assert.deepEqual(await laura((tx) => suggestPosts(tx, CAMPAIGN_CAFE_ALMA)), [], 'ya están asociados: no se sugieren');
    await laura((tx) => unlinkPost(tx, CAMPAIGN_CAFE_ALMA, POST_D01_REEL_CAFE_ALMA));
    await laura((tx) => unlinkPost(tx, CAMPAIGN_CAFE_ALMA, POST_D02_TIKTOK_CAFE_ALMA));
    try {
      const sugeridos = await laura((tx) => suggestPosts(tx, CAMPAIGN_CAFE_ALMA));
      assert.deepEqual(
        sugeridos.map((s) => [s.postId, s.reasons.map((r) => r.text)]),
        [
          [POST_D01_REEL_CAFE_ALMA, ['Menciona a @cafealma', 'Incluye el código LAURA15']],
          [POST_D02_TIKTOK_CAFE_ALMA, ['Menciona a @cafealma.co']],
        ],
      );
      cercaDelMock(sugeridos[0]?.views, 412000, 'el reel sugerido');
      // Nutrivé (15–22 jul): su único post ya está asociado; nada que sugerir, y nunca los de Café Alma.
      assert.deepEqual(await laura((tx) => suggestPosts(tx, CAMPAIGN_NUTRIVE)), []);
    } finally {
      await laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_CAFE_ALMA, postId: POST_D01_REEL_CAFE_ALMA, deliverable: 'reel', isPrimary: true }));
      await laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_CAFE_ALMA, postId: POST_D02_TIKTOK_CAFE_ALMA, deliverable: 'tiktok', isPrimary: false }));
    }
    const posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_CAFE_ALMA));
    assert.deepEqual(posts.map((p) => [p.postId, p.isPrimary]), [[POST_D01_REEL_CAFE_ALMA, true], [POST_D02_TIKTOK_CAFE_ALMA, false]]);
  });

  test('sin fechas no hay ventana ni sugerencias', async () => {
    await laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { startsOn: null, endsOn: null }));
    assert.deepEqual(await laura((tx) => suggestPosts(tx, CAMPAIGN_PRUEBA)), []);
    await laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { startsOn: '2026-10-01', endsOn: '2026-10-08' }));
  });
});

describe('editar y cambiar de estado', () => {
  test('updateCampaign: fechas coherentes, nombre obligatorio, null limpia y undefined conserva', async () => {
    await assert.rejects(laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { endsOn: '2026-09-30' })), (e: unknown) => e instanceof InvalidDatesError && /anterior/.test(e.messageEs));
    await assert.rejects(laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { startsOn: '2026-10-09' })), InvalidDatesError);
    await assert.rejects(laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { name: '   ' })), /nombre/);
    await assert.rejects(laura((tx) => updateCampaign(tx, CAMPAIGN_AJENA, { name: 'x' })), CampaignNotFoundError);

    const c = await laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { trackingCode: ' LAURAPRUEBA ', trackingUrl: 'https://ejemplo.co/?utm_campaign=prueba', brief: 'Un brief' }));
    assert.equal(c.trackingCode, 'LAURAPRUEBA');
    assert.equal(c.trackingUrl, 'https://ejemplo.co/?utm_campaign=prueba');
    assert.equal(c.brief, 'Un brief');
    assert.equal(c.startsOn, '2026-10-01', 'undefined conserva');

    const d = await laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { trackingUrl: null, endsOn: '2026-10-10' }));
    assert.equal(d.trackingUrl, null, 'null limpia');
    assert.equal(d.trackingCode, 'LAURAPRUEBA');
    assert.equal(d.endsOn, '2026-10-10');
  });

  test('transiciones válidas e inválidas; al pasar a live se fija la línea base', async () => {
    const before = await laura((tx) => getCampaign(tx, CAMPAIGN_PRUEBA));
    assert.equal(before?.status, 'planned');
    assert.equal(before?.brandBaselineFrom, null);

    await assert.rejects(laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'measuring')), InvalidCampaignTransition);
    await assert.rejects(laura((tx) => transitionCampaign(tx, CAMPAIGN_AJENA, 'live')), CampaignNotFoundError);
    assert.equal((await laura((tx) => getCampaign(tx, CAMPAIGN_PRUEBA)))?.status, 'planned', 'una transición inválida no escribe');

    const live = await laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'live'));
    assert.equal(live.status, 'live');
    assert.equal(live.brandBaselineFrom, '2026-09-17', 'starts_on − 14');
    await assert.rejects(laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'planned')), InvalidCampaignTransition);

    assert.equal((await laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'measuring'))).status, 'measuring');
    await assert.rejects(laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'cancelled')), InvalidCampaignTransition);
    assert.equal((await laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'reported'))).status, 'reported');
    const closed = await laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'closed'));
    assert.equal(closed.status, 'closed');
    await assert.rejects(laura((tx) => transitionCampaign(tx, CAMPAIGN_PRUEBA, 'live')), InvalidCampaignTransition);
  });

  test('una campaña cerrada no admite asociar, quitar ni editar', async () => {
    await assert.rejects(laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_PRUEBA, postId: POST_D05_YOUTUBE_NUTRIVE })), (e: unknown) => e instanceof CampaignLockedError && /cerrada/.test(e.messageEs));
    await assert.rejects(laura((tx) => unlinkPost(tx, CAMPAIGN_PRUEBA, POST_D05_YOUTUBE_NUTRIVE)), CampaignLockedError);
    await assert.rejects(laura((tx) => updateCampaign(tx, CAMPAIGN_PRUEBA, { name: 'Otro' })), CampaignLockedError);
    // Quitar de una cancelada tampoco, pero cancelar solo vale desde planned o live: la ajena sirve de ejemplo.
    await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => transitionCampaign(tx, CAMPAIGN_AJENA, 'cancelled'));
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => updateCampaign(tx, CAMPAIGN_AJENA, { name: 'Otro' })),
      (e: unknown) => e instanceof CampaignLockedError && /cancelada/.test(e.messageEs),
    );
  });
});

// ---------------------------------------------------------------------
// CAM-2 · createCampaignFromQuote: el contrato con COT-4
// ---------------------------------------------------------------------

const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const QUOTE_ACCEPTED = '00000003-0000-4000-8000-0000c0700001';
const QUOTE_SENT = '00000003-0000-4000-8000-0000c0700002';
const QUOTE_RACE = '00000003-0000-4000-8000-0000c0700003';
const QUOTE_FLOW = '00000003-0000-4000-8000-0000c0700004';

describe('crear campaña desde la cotización (CAM-2)', () => {
  before(async () => {
    // El seed no trae cotizaciones: las inserta la prueba, bajo el workspace de Laura.
    const quote = (id: string, number: string, status: string) => `
      INSERT INTO quote (id, workspace_id, company_id, creator_id, number, slug, currency, subtotal, tax, total,
                         agreed_metrics, report_cuts_hours, usage_rights_days, exclusivity_days, exclusivity_scope, payment_terms_days, status)
      VALUES ('${id}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${CREATOR_LAURA}', '${number}', 'cot-${number.toLowerCase()}', 'COP',
              5100000.00, 969000.00, 6069000.00, '{views,reach,link_clicks}', '{168,720}', 90, 30, 'café', 45, '${status}')
      ON CONFLICT DO NOTHING;
      INSERT INTO quote_item (quote_id, deliverable, platform_id, description, quantity, unit_price, total, position)
      SELECT '${id}', 'reel', 'instagram', '1 reel de cold brew', 1, 3200000.00, 3200000.00, 0
      WHERE NOT EXISTS (SELECT 1 FROM quote_item WHERE quote_id = '${id}');
      INSERT INTO quote_item (quote_id, deliverable, platform_id, description, quantity, unit_price, total, position)
      SELECT '${id}', 'historia', 'instagram', '3 historias', 3, 633333.33, 1900000.00, 1
      WHERE (SELECT count(*) FROM quote_item WHERE quote_id = '${id}') < 2;
    `;
    await t.admin(quote(QUOTE_ACCEPTED, 'COT-2026-014', 'accepted') + quote(QUOTE_SENT, 'COT-2026-015', 'sent') + quote(QUOTE_RACE, 'COT-2026-016', 'accepted') + quote(QUOTE_FLOW, 'COT-2026-017', 'sent'));
  });

  test('crea la campaña con lo copiado de la cotización, la línea base y las cuentas de la marca', async () => {
    const { campaign, created } = await laura((tx) =>
      createCampaignFromQuote(tx, { quoteId: QUOTE_ACCEPTED, startsOn: '2026-11-03', endsOn: '2026-11-10', trackingCode: 'LAURA30' }),
    );
    assert.equal(created, true);
    assert.equal(campaign.status, 'planned');
    assert.equal(campaign.name, 'Café Alma · 1 reel de cold brew');
    assert.equal(campaign.companyId, COMPANY_CAFE_ALMA);
    assert.equal(campaign.creatorId, CREATOR_LAURA);
    assert.equal(campaign.quoteId, QUOTE_ACCEPTED);
    assert.equal(campaign.dealId, null);
    assert.equal(campaign.amount, '6069000.00', 'quote.total como string, sin aritmética');
    assert.equal(campaign.currency, 'COP');
    assert.equal(campaign.startsOn, '2026-11-03');
    assert.equal(campaign.endsOn, '2026-11-10');
    assert.equal(campaign.brandBaselineFrom, '2026-10-20', 'startsOn − 14');
    assert.deepEqual(campaign.brandAccounts, [
      { platform_id: 'instagram', handle: 'cafealma' },
      { platform_id: 'tiktok', handle: 'cafealma.co' },
    ]);
    assert.equal(campaign.trackingCode, 'LAURA30');
    assert.equal(campaign.trackingUrl, null);
    assert.deepEqual(campaign.utm, {});
    assert.match(campaign.brief ?? '', /^Métricas acordadas: views, reach, link_clicks\.\nCortes del reporte: 7 días, 30 días\.\nDerechos de uso: 90 días\.\nExclusividad: 30 días \(café\)\.\nPlazo de pago: 45 días\.$/);
    assert.equal(campaign.postsCount, 0);
    assert.equal(campaign.viewsTotal, null);
    assert.equal(campaign.hasInvoice, false);
  });

  test('aparece en la lista y la ficha muestra lo acordado y los entregables desde la cotización', async () => {
    const rows = await laura((tx) => listCampaigns(tx, { status: 'planned' }));
    const row = rows.find((r) => r.name === 'Café Alma · 1 reel de cold brew');
    assert.ok(row, 'está en la lista');
    const c = await laura((tx) => getCampaign(tx, row.id));
    assert.ok(c);
    assert.deepEqual(c.agreed, {
      quoteId: QUOTE_ACCEPTED,
      quoteNumber: 'COT-2026-014',
      quoteStatus: 'accepted',
      agreedMetrics: ['views', 'reach', 'link_clicks'],
      reportCutsHours: [168, 720],
      usageRightsDays: 90,
      exclusivityDays: 30,
      exclusivityScope: 'café',
      paymentTermsDays: 45,
    });
    assert.equal(c.deliverablesSource, 'quote');
    assert.deepEqual(c.deliverables.map((d) => [d.deliverable, d.quantity, d.platformId]), [['reel', 1, 'instagram'], ['historia', 3, 'instagram']]);
  });

  test('una segunda llamada con la misma cotización devuelve la misma campaña con created false, sin cambiar nada', async () => {
    const first = await laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_ACCEPTED, startsOn: '2026-11-03', endsOn: '2026-11-10' }));
    const again = await laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_ACCEPTED, startsOn: '2026-12-01', endsOn: '2026-12-02', name: 'Otro nombre' }));
    assert.equal(first.created, false);
    assert.equal(again.created, false);
    assert.equal(again.campaign.id, first.campaign.id);
    assert.equal(again.campaign.name, 'Café Alma · 1 reel de cold brew', 'no pisa el nombre');
    assert.equal(again.campaign.startsOn, '2026-11-03', 'no pisa las fechas');
    const n = await laura((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM campaign WHERE quote_id = $1', [QUOTE_ACCEPTED]));
    assert.equal(n.rows[0]?.n, 1);
  });

  test('dos aceptaciones concurrentes crean una sola campaña', async () => {
    const [a, b] = await Promise.all([
      laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_RACE, startsOn: '2026-11-17', endsOn: '2026-11-24' })),
      laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_RACE, startsOn: '2026-11-17', endsOn: '2026-11-24' })),
    ]);
    assert.equal(a.campaign.id, b.campaign.id);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    const n = await laura((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM campaign WHERE quote_id = $1', [QUOTE_RACE]));
    assert.equal(n.rows[0]?.n, 1);
  });

  test('una cotización en sent no crea campaña', async () => {
    await assert.rejects(
      laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SENT, startsOn: '2026-11-03', endsOn: '2026-11-10' })),
      (e: unknown) => e instanceof QuoteNotAcceptedError && e.status === 'sent' && /aceptada/.test(e.messageEs),
    );
    const n = await laura((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM campaign WHERE quote_id = $1', [QUOTE_SENT]));
    assert.equal(n.rows[0]?.n, 0);
  });

  test('una cotización de otro workspace es «no encontrada»', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_ACCEPTED, startsOn: '2026-11-03', endsOn: '2026-11-10' })),
      (e: unknown) => e instanceof QuoteNotFoundError && /no existe en este workspace/.test(e.messageEs),
    );
    await assert.rejects(
      laura((tx) => createCampaignFromQuote(tx, { quoteId: '00000003-0000-4000-8000-0000c0700099', startsOn: '2026-11-03', endsOn: '2026-11-10' })),
      QuoteNotFoundError,
    );
    await assert.rejects(laura((tx) => createCampaignFromQuote(tx, { quoteId: 'no-es-uuid', startsOn: '2026-11-03', endsOn: '2026-11-10' })), QuoteNotFoundError);
  });

  test('fechas inválidas: fin anterior a inicio o no ISO', async () => {
    await assert.rejects(
      laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SENT, startsOn: '2026-11-10', endsOn: '2026-11-03' })),
      (e: unknown) => e instanceof InvalidDatesError && /anterior/.test(e.messageEs),
    );
    await assert.rejects(laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SENT, startsOn: '2026-02-30', endsOn: '2026-03-01' })), InvalidDatesError);
    await assert.rejects(laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SENT, startsOn: '10/11/2026', endsOn: '2026-11-12' })), InvalidDatesError);
    await assert.rejects(
      laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SENT, startsOn: '2026-11-10', endsOn: '2026-11-12', name: '   ' })),
      (e: unknown) => e instanceof InvalidNameError && /nombre/.test(e.messageEs),
      'un nombre en blanco no cae al nombre por defecto: se rechaza como en updateCampaign',
    );
  });

  test('una campaña cancelada libera la cotización: se puede crear otra; una activa la bloquea también en la base', async () => {
    const first = await laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_RACE, startsOn: '2026-11-17', endsOn: '2026-11-24' }));
    assert.equal(first.created, false);
    // El índice único parcial (0016) protege incluso a quien no pase por la función.
    await assert.rejects(
      laura((tx) => tx.query(
        `INSERT INTO campaign (workspace_id, company_id, quote_id, name, status)
         VALUES (current_workspace_id(), $1, $2, 'Duplicada a mano', 'planned')`,
        [COMPANY_CAFE_ALMA, QUOTE_RACE],
      )),
      /campaign_quote_id_active_key/,
    );
    await laura((tx) => transitionCampaign(tx, first.campaign.id, 'cancelled'));
    const second = await laura((tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_RACE, startsOn: '2026-12-15', endsOn: '2026-12-22' }));
    assert.equal(second.created, true);
    assert.notEqual(second.campaign.id, first.campaign.id);
    assert.equal(second.campaign.status, 'planned');
    const n = await laura((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM campaign WHERE quote_id = $1', [QUOTE_RACE]));
    assert.equal(n.rows[0]?.n, 2, 'la cancelada queda como historial');
  });

  test('el flujo de COT-4 de punta a punta: aceptar y crear en UNA transacción, y si algo falla no queda nada', async () => {
    // Primer intento: la acción de Rasheed falla después de crear la campaña → rollback de todo.
    await assert.rejects(
      laura(async (tx) => {
        await tx.query("UPDATE quote SET status = 'accepted', accepted_at = now() WHERE id = $1", [QUOTE_FLOW]);
        const r = await createCampaignFromQuote(tx, { quoteId: QUOTE_FLOW, startsOn: '2026-12-01', endsOn: '2026-12-08' });
        assert.equal(r.created, true);
        throw new Error('falló el UPDATE de deal');
      }),
      /falló el UPDATE de deal/,
    );
    const after = await laura((tx) => tx.query<{ status: string; n: number }>(
      'SELECT q.status, (SELECT count(*)::int FROM campaign c WHERE c.quote_id = q.id) AS n FROM quote q WHERE q.id = $1',
      [QUOTE_FLOW],
    ));
    assert.equal(after.rows[0]?.status, 'sent', 'la cotización no quedó aceptada');
    assert.equal(after.rows[0]?.n, 0, 'ni quedó campaña');

    // Segundo intento: todo bien. La campaña queda en planned y se ve en el módulo.
    const { campaign, created } = await laura(async (tx) => {
      await tx.query("UPDATE quote SET status = 'accepted', accepted_at = now() WHERE id = $1", [QUOTE_FLOW]);
      return createCampaignFromQuote(tx, { quoteId: QUOTE_FLOW, startsOn: '2026-12-01', endsOn: '2026-12-08', name: 'Navidad con Café Alma' });
    });
    assert.equal(created, true);
    assert.equal(campaign.name, 'Navidad con Café Alma');
    const planned = await laura((tx) => listCampaigns(tx, { status: 'planned' }));
    assert.ok(planned.some((c) => c.id === campaign.id));
    assert.equal((await laura((tx) => getCampaign(tx, campaign.id)))?.agreed?.quoteNumber, 'COT-2026-017');
  });
});

// ---------------------------------------------------------------------
// Lo que aporta la marca (CAM-4)
// ---------------------------------------------------------------------

describe('lo que aporta la marca', () => {
  const ajeno = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_AJENO, fn);
  const filasDe = (campaignId: string) =>
    laura((tx) => tx.query<{ kind: string; source: string; day: string; value: string; currency: string | null }>(
      `SELECT kind, source, to_char(day, 'YYYY-MM-DD') AS day, value_num::text AS value, currency
       FROM campaign_brand_input WHERE campaign_id = $1 ORDER BY source, kind, day, received_at`,
      [campaignId],
    )).then((r) => r.rows);
  const bitacora = (action: string) =>
    laura((tx) => tx.query<{ entity_type: string; entity_id: string; actor_user_id: string | null; after: Record<string, unknown> }>(
      `SELECT entity_type, entity_id, actor_user_id, after FROM audit_log WHERE action = $1 ORDER BY created_at, id`,
      [action],
    )).then((r) => r.rows);

  test('Café Alma trae del seed los dos totales manuales: 318 canjes y 8,4 M al 11 de septiembre', async () => {
    const r = await laura((tx) => listBrandInputs(tx, CAMPAIGN_CAFE_ALMA));
    assert.equal(r.currency, 'COP');
    assert.deepEqual(
      r.totals.map((x) => [x.kind, x.source, x.semantics, x.value, x.currency, x.asOf, x.from, x.count]),
      [
        ['code_redemptions', 'brand_manual', 'total', '318.00', null, '2026-09-11', null, 1],
        ['revenue', 'brand_manual', 'total', '8400000.00', 'COP', '2026-09-11', null, 1],
      ],
    );
    assert.deepEqual(r.daily, [], 'sin CSV no hay serie diaria');
    const fresko = await laura((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(fresko.totals, [], 'Fresko no tiene aportes: lista vacía, no ceros');
  });

  test('registrar un total por formulario: la misma alta no duplica, otra cifra manda por ser la última', async () => {
    const primera = await laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'code_redemptions', day: '2026-09-20', value: '40', notes: 'Correo de la marca, lunes' }));
    assert.equal(primera.created, true);
    assert.equal(primera.campaignCurrency, 'COP');
    assert.deepEqual([primera.input.kind, primera.input.source, primera.input.day, primera.input.value, primera.input.currency], ['code_redemptions', 'brand_manual', '2026-09-20', '40.00', null]);

    const repetida = await laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'code_redemptions', day: '2026-09-20', value: '40' }));
    assert.equal(repetida.created, false);
    assert.equal(repetida.input.id, primera.input.id, 'devuelve la que ya estaba');

    const corregida = await laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'code_redemptions', day: '2026-09-20', value: '45' }));
    assert.equal(corregida.created, true);

    const r = await laura((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(r.totals.map((x) => [x.kind, x.value, x.asOf, x.count]), [['code_redemptions', '45.00', '2026-09-20', 2]], 'la última alta manda; hay dos filas detrás');
  });

  test('una corrección de vuelta (318 → 320 → 318) queda, y un dato atrasado no hace retroceder el acumulado', async () => {
    const add = (day: string, value: string) => laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'signups', day, value }));
    assert.equal((await add('2026-09-15', '318')).created, true);
    assert.equal((await add('2026-09-15', '320')).created, true);
    assert.equal((await add('2026-09-15', '318')).created, true, 'no es la última de ese día: se registra');
    assert.equal((await add('2026-09-15', '318')).created, false, 'ahora sí es la última igual');
    let r = await laura((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(r.totals.filter((x) => x.kind === 'signups').map((x) => [x.value, x.asOf, x.count]), [['318.00', '2026-09-15', 3]]);
    assert.equal((await add('2026-09-05', '200')).created, true);
    r = await laura((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(
      r.totals.filter((x) => x.kind === 'signups').map((x) => [x.value, x.asOf]),
      [['318.00', '2026-09-15']],
      'el total a la fecha más reciente manda aunque el del 5 se haya cargado después',
    );
  });

  test('ingresos: sin moneda toma la de la campaña; con otra se guarda tal cual y la respuesta dice cuál es la de la campaña', async () => {
    const cop = await laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'revenue', day: '2026-09-20', value: '1500000.50' }));
    assert.equal(cop.input.currency, 'COP');
    assert.equal(cop.input.value, '1500000.50');
    const usd = await laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'revenue', day: '2026-09-21', value: '400', currency: 'usd' }));
    assert.equal(usd.input.currency, 'USD');
    assert.equal(usd.campaignCurrency, 'COP');
    const r = await laura((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO));
    const revenue = r.totals.find((x) => x.kind === 'revenue');
    assert.deepEqual([revenue?.value, revenue?.currency, revenue?.asOf, revenue?.count], ['400.00', 'USD', '2026-09-21', 2]);
  });

  test('valida antes de escribir: kind, fecha, cifra y moneda', async () => {
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'csv_sales' as 'orders', day: '2026-09-20', value: '1' })), InvalidBrandInputError);
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'orders', day: '20/09/2026', value: '1' })), InvalidBrandInputError);
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'orders', day: '2026-09-20', value: '1.5' })), InvalidBrandInputError);
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'revenue', day: '2026-09-20', value: '1.555' })), InvalidBrandInputError);
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'revenue', day: '2026-09-20', value: '-1' })), InvalidBrandInputError);
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'revenue', day: '2026-09-20', value: '1', currency: 'pesos' })), InvalidBrandInputError);
  });

  test('una campaña cerrada no admite aportes ni CSV', async () => {
    await assert.rejects(laura((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_NUTRIVE, kind: 'orders', day: '2026-08-01', value: '3' })), CampaignLockedError);
    await assert.rejects(
      laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_NUTRIVE, rows: [{ line: 2, day: '2026-07-20', sales: '10.00', orders: null, redemptions: null }] })),
      CampaignLockedError,
    );
    assert.deepEqual(await filasDe(CAMPAIGN_NUTRIVE), [], 'no quedó nada escrito');
  });

  test('desde otro workspace la campaña no existe: ni leer, ni registrar, ni importar', async () => {
    const antes = await filasDe(CAMPAIGN_FRESKO);
    await assert.rejects(ajeno((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO)), CampaignNotFoundError);
    await assert.rejects(ajeno((tx) => addBrandInput(tx, { campaignId: CAMPAIGN_FRESKO, kind: 'orders', day: '2026-09-20', value: '1' })), CampaignNotFoundError);
    await assert.rejects(
      ajeno((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: [{ line: 2, day: '2026-09-02', sales: '10.00', orders: null, redemptions: null }] })),
      CampaignNotFoundError,
    );
    assert.deepEqual(await filasDe(CAMPAIGN_FRESKO), antes, 'Fresko sigue igual');
    const desdeAjeno = await ajeno((tx) => tx.query('SELECT 1 FROM campaign_brand_input WHERE campaign_id = $1', [CAMPAIGN_FRESKO]));
    assert.equal(desdeAjeno.rows.length, 0, 'RLS: las filas de Laura no se ven desde el workspace ajeno');
  });

  const csv = [
    { line: 2, day: '2026-09-02', sales: '1250000.50', orders: 12, redemptions: 3 },
    { line: 3, day: '2026-09-03', sales: '980000.00', orders: 9, redemptions: 2 },
    { line: 4, day: '2026-09-04', sales: '640000.00', orders: null, redemptions: null },
  ];

  test('importar el CSV llena la tabla por día; repetirlo no duplica; una cifra corregida se reemplaza', async () => {
    const primera = await laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: csv }));
    assert.deepEqual(primera, { inserted: 7, unchanged: 0, replaced: 0, days: 3, from: '2026-09-02', to: '2026-09-04' });

    const segunda = await laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: csv }));
    assert.deepEqual(segunda, { inserted: 0, unchanged: 7, replaced: 0, days: 3, from: '2026-09-02', to: '2026-09-04' });
    const filas = (await filasDe(CAMPAIGN_FRESKO)).filter((f) => f.source === 'brand_csv');
    assert.equal(filas.length, 7, 'siete filas, no catorce');

    const corregido = csv.map((r) => (r.day === '2026-09-03' ? { ...r, sales: '990000.00' } : r));
    const tercera = await laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: corregido }));
    assert.deepEqual(tercera, { inserted: 0, unchanged: 6, replaced: 1, days: 3, from: '2026-09-02', to: '2026-09-04' });

    const r = await laura((tx) => listBrandInputs(tx, CAMPAIGN_FRESKO));
    assert.deepEqual(
      r.totals.filter((x) => x.source === 'brand_csv').map((x) => [x.kind, x.semantics, x.value, x.currency, x.from, x.asOf, x.count]),
      [
        ['code_redemptions', 'daily', '5.00', null, '2026-09-02', '2026-09-03', 2],
        ['csv_sales', 'daily', '2880000.50', 'COP', '2026-09-02', '2026-09-04', 3],
        ['orders', 'daily', '21.00', null, '2026-09-02', '2026-09-03', 2],
      ],
      'sumas por kind desde SQL, con la moneda de la campaña en las ventas',
    );
    assert.deepEqual(r.daily, [
      { day: '2026-09-02', sales: '1250000.50', orders: 12, redemptions: 3 },
      { day: '2026-09-03', sales: '990000.00', orders: 9, redemptions: 2 },
      { day: '2026-09-04', sales: '640000.00', orders: null, redemptions: null },
    ]);
    // Los totales manuales de las pruebas anteriores siguen aparte: la fuente los separa.
    assert.deepEqual(r.totals.filter((x) => x.source === 'brand_manual').map((x) => x.kind), ['code_redemptions', 'revenue', 'signups']);
  });

  test('la ventana starts_on − 7 … ends_on + 60 se vuelve a comprobar en la base; sin fechas no hay importación', async () => {
    await assert.rejects(
      laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: [{ line: 2, day: '2026-08-25', sales: '1.00', orders: null, redemptions: null }] })),
      BrandCsvOutOfWindowError,
    );
    await assert.rejects(
      laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: [{ line: 2, day: '2026-11-09', sales: '1.00', orders: null, redemptions: null }] })),
      BrandCsvOutOfWindowError,
    );
    const limites = await laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: [
      { line: 2, day: '2026-08-26', sales: '1.00', orders: null, redemptions: null },
      { line: 3, day: '2026-11-08', sales: '2.00', orders: null, redemptions: null },
    ] }));
    assert.equal(limites.inserted, 2, 'los dos extremos entran');
    await assert.rejects(
      laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_SIN_FECHAS, rows: [{ line: 2, day: '2026-09-02', sales: '1.00', orders: null, redemptions: null }] })),
      CampaignWithoutDatesError,
    );
    await assert.rejects(
      laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: [
        { line: 2, day: '2026-09-10', sales: '1.00', orders: null, redemptions: null },
        { line: 3, day: '2026-09-10', sales: '2.00', orders: null, redemptions: null },
      ] })),
      InvalidBrandInputError,
      'dos filas del mismo día no se escriben',
    );
    assert.deepEqual(await laura((tx) => openBrandCsvImport(tx, CAMPAIGN_FRESKO)), { window: { from: '2026-08-26', to: '2026-11-08' }, currency: 'COP' });
    await assert.rejects(laura((tx) => openBrandCsvImport(tx, CAMPAIGN_NUTRIVE)), CampaignLockedError);
    await assert.rejects(laura((tx) => openBrandCsvImport(tx, CAMPAIGN_SIN_FECHAS)), CampaignWithoutDatesError);
    const vacio = await laura((tx) => importBrandCsv(tx, { campaignId: CAMPAIGN_FRESKO, rows: [] }));
    assert.deepEqual(vacio, { inserted: 0, unchanged: 0, replaced: 0, days: 0, from: null, to: null });
  });

  test('cada alta y cada importación dejan bitácora, sin el texto libre de la persona', async () => {
    const altas = await bitacora('campaign.brand_input.added');
    assert.ok(altas.length >= 4, `una entrada por alta nueva (hay ${altas.length})`);
    for (const a of altas) {
      assert.equal(a.entity_type, 'campaign_brand_input');
      assert.deepEqual(Object.keys(a.after).sort(), ['campaign_id', 'currency', 'day', 'kind', 'source', 'value']);
      assert.equal(a.actor_user_id, null, 'sin identidad en la transacción no se inventa un actor');
    }
    const texto = JSON.stringify(altas);
    assert.doesNotMatch(texto, /Correo de la marca/, 'las notas no viajan a la bitácora');

    const importaciones = await bitacora('campaign.brand_csv.imported');
    assert.ok(importaciones.length >= 3);
    const primera = importaciones.find((i) => i.after.inserted === 7);
    assert.ok(primera, 'la primera importación con sus conteos');
    assert.deepEqual(primera.after, { source: 'brand_csv', currency: 'COP', days: 3, from: '2026-09-02', to: '2026-09-04', inserted: 7, replaced: 0, unchanged: 0 });
    assert.equal(primera.entity_id, CAMPAIGN_FRESKO);
    // La bitácora del workspace ajeno no ve nada de esto.
    const desdeAjeno = await ajeno((tx) => tx.query("SELECT 1 FROM audit_log WHERE action LIKE 'campaign.brand%'"));
    assert.equal(desdeAjeno.rows.length, 0);
  });
});
