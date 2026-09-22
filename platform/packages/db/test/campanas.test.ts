import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignLockedError, InvalidCampaignTransition, InvalidDatesError } from '@mc/core';
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
  type WorkspaceTx,
} from '../src/index.ts';
import {
  openTestDb, type TestDb,
  WORKSPACE_LAURA, COMPANY_CAFE_ALMA, CAMPAIGN_CAFE_ALMA, CAMPAIGN_FRESKO, CAMPAIGN_NUTRIVE, CAMPAIGN_HOGAR_LINDO,
  POST_D01_REEL_CAFE_ALMA, POST_D02_TIKTOK_CAFE_ALMA, POST_D03_TIKTOK_FRESKO, POST_D04_TIKTOK_FRESKO, POST_D05_YOUTUBE_NUTRIVE,
} from './helpers/base.ts';

/** Un workspace ajeno con una campaña propia, para las pruebas de aislamiento. */
const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000001';
const CAMPAIGN_AJENA = '00000009-0000-4000-8000-0000000ca001';
/** Una campaña nueva de Laura, en planned, para las transiciones. */
const CAMPAIGN_PRUEBA = '00000003-0000-4000-8000-00000ca0f001';

let t: TestDb;
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);

before(async () => {
  t = await openTestDb();
  // Como superusuario (sin RLS): el workspace ajeno y su campaña, que
  // apunta a la misma empresa porque company no tiene workspace.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno-campanas', 'Workspace ajeno', 'creator', 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on)
    VALUES ('${CAMPAIGN_AJENA}', '${WORKSPACE_AJENO}', '${COMPANY_CAFE_ALMA}', 'Campaña ajena', 'planned', DATE '2026-08-24', DATE '2026-08-31')
    ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, amount, currency)
    VALUES ('${CAMPAIGN_PRUEBA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', 'Campaña de prueba', 'planned', DATE '2026-10-01', DATE '2026-10-08', 1000000.00, 'COP')
    ON CONFLICT DO NOTHING;
  `);
});

after(async () => {
  await t.close();
});

describe('lista y ficha', () => {
  test('la lista da las cuatro campañas del mock con sus cifras', async () => {
    const rows = await laura((tx) => listCampaigns(tx));
    const seed = rows.filter((r) => r.id !== CAMPAIGN_PRUEBA);
    assert.deepEqual(
      seed.map((r) => [r.companyName, r.status, r.postsCount, r.viewsTotal, r.amount, r.hasInvoice]),
      [
        ['Fresko Market', 'measuring', 2, 265000, '5200000.00', true],
        ['Café Alma', 'reported', 2, 712000, '3100000.00', true],
        ['Nutrivé', 'closed', 1, 58000, '4700000.00', true],
        ['Hogar Lindo', 'reported', 0, null, '1100000.00', true],
      ],
      'más recientes primero; sin posts no hay views (null, no cero)',
    );
    const cafe = rows.find((r) => r.id === CAMPAIGN_CAFE_ALMA);
    assert.equal(cafe?.dataAsOf, '2026-09-26T06:00:00Z', 'el snapshot más reciente de sus posts');
    assert.equal(cafe?.startsOn, '2026-08-24');
    assert.equal(cafe?.endsOn, '2026-08-31');
    assert.equal(rows.find((r) => r.id === CAMPAIGN_HOGAR_LINDO)?.dataAsOf, null);
    assert.equal(rows.find((r) => r.id === CAMPAIGN_PRUEBA)?.hasInvoice, false);
  });

  test('filtro por estado', async () => {
    const reported = await laura((tx) => listCampaigns(tx, { status: 'reported' }));
    assert.deepEqual(reported.map((r) => r.companyName), ['Café Alma', 'Hogar Lindo']);
    const varios = await laura((tx) => listCampaigns(tx, { status: ['closed', 'measuring'] }));
    assert.deepEqual(varios.map((r) => r.companyName), ['Fresko Market', 'Nutrivé']);
  });

  test('la ficha de Café Alma: sin cotización, entregables desde los posts, factura enlazada', async () => {
    const c = await laura((tx) => getCampaign(tx, CAMPAIGN_CAFE_ALMA));
    assert.ok(c);
    assert.equal(c.name, 'Lanzamiento cold brew');
    assert.equal(c.trackingCode, 'LAURA15');
    assert.match(c.trackingUrl ?? '', /^https:\/\/cafealma\.co\//);
    assert.deepEqual(c.utm, { utm_source: 'instagram', utm_medium: 'creator', utm_campaign: 'laura_coldbrew' });
    assert.equal(c.brandBaselineFrom, '2026-08-10');
    assert.equal(c.agreed, null, 'la campaña del seed se creó a mano');
    assert.equal(c.deliverablesSource, 'posts');
    assert.deepEqual(c.deliverables.map((d) => [d.deliverable, d.quantity]), [['reel', 1], ['tiktok', 1]]);
    assert.deepEqual(c.invoices.map((i) => [i.number, i.status, i.total]), [['FV-2026-010', 'sent', '3100000.00']]);
    assert.equal(c.viewsTotal, 712000);
    assert.equal(await laura((tx) => getCampaign(tx, '00000003-0000-4000-8000-000000000000')), null);
  });

  test('los posts de Café Alma: dos, 412 K + 300 K, el principal primero, con datos hasta', async () => {
    const posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_CAFE_ALMA));
    assert.deepEqual(
      posts.map((p) => [p.postId, p.platformId, p.views, p.isPrimary, p.deliverable]),
      [
        [POST_D01_REEL_CAFE_ALMA, 'instagram', 412000, true, 'reel'],
        [POST_D02_TIKTOK_CAFE_ALMA, 'tiktok', 300000, false, 'tiktok'],
      ],
    );
    assert.equal(posts[0]?.reach, 296000);
    assert.equal(posts[0]?.saves, 6200);
    assert.equal(posts[0]?.dataAsOf, '2026-09-23T06:00:00Z');
    assert.equal(posts[0]?.publishedAt, '2026-08-24T17:00:00Z');
    assert.equal(posts[1]?.dataAsOf, '2026-09-26T06:00:00Z');
  });
});

describe('asociar y quitar posts', () => {
  test('asociar a Fresko un post que no es suyo y quitarlo; asociar dos veces no duplica', async () => {
    const linked = await laura((tx) => linkPost(tx, { campaignId: CAMPAIGN_FRESKO, postId: POST_D05_YOUTUBE_NUTRIVE, deliverable: 'dedicado' }));
    assert.equal(linked.postId, POST_D05_YOUTUBE_NUTRIVE);
    assert.equal(linked.views, 58000, 'con sus views actuales');
    assert.equal(linked.deliverable, 'dedicado');
    assert.equal(linked.isPrimary, false);

    let posts = await laura((tx) => listCampaignPosts(tx, CAMPAIGN_FRESKO));
    assert.equal(posts.length, 3);
    const lista = await laura((tx) => listCampaigns(tx, { status: 'measuring' }));
    assert.equal(lista[0]?.viewsTotal, 265000 + 58000, 'la lista suma el post nuevo');

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
    assert.deepEqual(todos.map((p) => p.postId), [POST_D04_TIKTOK_FRESKO, POST_D03_TIKTOK_FRESKO, POST_D05_YOUTUBE_NUTRIVE], 'más recientes primero');
    assert.equal(todos[0]?.views, 125000);
    const fresko = await laura((tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA, q: 'FRESKO' }));
    assert.deepEqual(fresko.map((p) => p.postId), [POST_D04_TIKTOK_FRESKO, POST_D03_TIKTOK_FRESKO]);
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
      assert.equal(sugeridos[0]?.views, 412000);
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
