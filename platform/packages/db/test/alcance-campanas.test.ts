/**
 * ACC-6 · Alcance en queries/campanas.ts: un miembro con alcance a Laura
 * no ve las campañas ni los posts de Sofía en NINGUNA función exportada,
 * y ninguna escritura suya toca lo de Sofía. Ver test/alcance.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as campanas from '../src/queries/campanas.ts';
import { CAMPAIGN_CAFE_ALMA, CAMPAIGN_FRESKO, POST_D03_TIKTOK_FRESKO } from './pglite.ts';
import {
  CAMPAIGN_LAURA_PRUEBA, CAMPAIGN_SOFIA, CREATOR_SOFIA, definirPruebasDeAlcance, POST_SOFIA, QUOTE_SOFIA,
  USER_MIEMBRO_CAMPANA, USER_MIEMBRO_MARCA, type CasoDeAlcance,
} from './alcance.ts';

const {
  listCampaigns, getCampaign, listCampaignPosts, listLinkablePosts, suggestPosts, linkPost, setPrimaryPost, unlinkPost,
  updateCampaign, transitionCampaign, createCampaignFromQuote, CampaignNotFoundError, CampaignPostNotFoundError,
  PostNotFoundError, QuoteNotFoundError,
} = campanas;

/** En orden: lecturas, luego escrituras (la pasada de control de la dueña las ejecuta de verdad). */
const CASOS: Record<string, CasoDeAlcance> = {
  listCampaigns: { run: (tx) => listCampaigns(tx), duena: 'nombra', miembro: 'nada' },
  getCampaign: { run: (tx) => getCampaign(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  listCampaignPosts: { run: (tx) => listCampaignPosts(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Desde una campaña de Laura: el post de Sofía es asociable para la dueña, invisible para el miembro.
  listLinkablePosts: { run: (tx) => listLinkablePosts(tx, { campaignId: CAMPAIGN_CAFE_ALMA, q: 'playa' }), duena: 'nombra', miembro: 'nada' },
  // El post de Sofía menciona a @cafealma dentro de la ventana de Café Alma: la dueña lo ve sugerido.
  suggestPosts: { run: (tx) => suggestPosts(tx, CAMPAIGN_CAFE_ALMA), duena: 'nombra', miembro: 'nada' },
  // Campaña de Laura + post de Sofía: para el miembro, el post no existe.
  linkPost: { run: (tx) => linkPost(tx, { campaignId: CAMPAIGN_LAURA_PRUEBA, postId: POST_SOFIA }), duena: 'nombra', miembro: { rechaza: PostNotFoundError } },
  setPrimaryPost: { run: (tx) => setPrimaryPost(tx, CAMPAIGN_SOFIA, POST_SOFIA), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  unlinkPost: { run: (tx) => unlinkPost(tx, CAMPAIGN_SOFIA, POST_SOFIA), duena: (r) => r === true, miembro: { rechaza: CampaignNotFoundError } },
  updateCampaign: { run: (tx) => updateCampaign(tx, CAMPAIGN_SOFIA, { name: 'Renombrada' }), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  transitionCampaign: { run: (tx) => transitionCampaign(tx, CAMPAIGN_SOFIA, 'live'), duena: 'nombra', miembro: { rechaza: CampaignNotFoundError } },
  createCampaignFromQuote: {
    run: (tx) => createCampaignFromQuote(tx, { quoteId: QUOTE_SOFIA, startsOn: '2026-11-03', endsOn: '2026-11-10' }),
    duena: 'nombra',
    miembro: { rechaza: QuoteNotFoundError },
  },
};

definirPruebasDeAlcance('campanas', campanas, CASOS, ({ duena, miembro, como }) => {
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
});
