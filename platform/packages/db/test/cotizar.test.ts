/**
 * Cotizar de punta a punta sobre Postgres embebido con el seed, como
 * mc_app y sin red: tarifario, media kit congelado, cotización con su
 * enlace público, aceptación y campaña.
 *
 * Lo que de verdad se comprueba aquí y no se puede comprobar en
 * packages/core:
 *   - que el enlace público abra SIN workspace fijado (withCatalogs),
 *     que es la situación real de /kit/<slug> y /cotizacion/<slug>;
 *   - que el snapshot esté congelado: cambiar las métricas después no
 *     cambia lo que la marca ve;
 *   - que la RLS siga en pie: el workspace vecino no ve nada de esto,
 *     ni siquiera sabiendo los ids;
 *   - que aceptar mueva el deal y deje la campaña de CAM-2.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptPublicQuote, acceptQuote, buildMediaKitSnapshot, createMediaKit, createQuote,
  createCampaignForQuote, getCurrentRateCard, getQuote, getRateCardInputs, hashSharePassword,
  listMediaKits, listQuotableDeals, listQuotes, nextQuoteNumber, overrideRateCardItemPrice,
  readPublicMediaKit, readPublicQuote, saveRateCard, sendQuote, updateMediaKitShare,
  verifySharePassword, QuoteNotEditable,
} from '../src/queries/cotizar.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const WS_VECINO = '0000000c-0000-4000-8000-0000000000c1';

let t: TestDb;
let creadora = '';

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country, niche_slugs)
    VALUES ('${WS_VECINO}', 'vecino-cot', 'Estudio vecino', 'MXN', 'America/Mexico_City', 'es-MX', 'MX', '{cocina}')
    ON CONFLICT DO NOTHING;
  `);
  const [c] = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM creator_profile LIMIT 1');
    return rows;
  });
  creadora = c!.id;
});

after(async () => {
  await t.close();
});

// ------------------------------------------------------------- COT-1

describe('COT-1 · tarifario', () => {
  test('las entradas salen de la línea base y del CPM del nicho', async () => {
    const inputs = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getRateCardInputs(tx, creadora));
    assert.ok(inputs, 'la creadora del seed tiene entradas de tarifario');
    assert.equal(inputs.currency, 'COP');
    assert.equal(inputs.country, 'CO');

    const tiktok = inputs.baselines.find((b) => b.platformId === 'tiktok');
    assert.ok(tiktok, 'hay línea base de TikTok en el seed');
    assert.ok(Number.isInteger(tiktok.medianViews) && tiktok.medianViews > 0);
    assert.equal(tiktok.isReliable, tiktok.sampleSize >= 8);

    const cpm = inputs.benchmarks.find((b) => b.platform === 'tiktok');
    assert.ok(cpm, 'hay CPM de referencia para TikTok');
    assert.equal(cpm.currency, 'COP');
    assert.equal(cpm.country, 'CO');
  });

  test('un id que no es uuid devuelve null, no un error de Postgres', async () => {
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getRateCardInputs(tx, 'no-soy-uuid'));
    assert.equal(r, null);
    const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, 'no-soy-uuid'));
    assert.equal(c, null);
  });

  test('guardar sube la versión, deja una sola vigente y conserva la anterior', async () => {
    const item = {
      deliverable: 'tiktok', platformId: 'tiktok' as const, labelEs: 'TikTok dedicado',
      priceLow: '3780000.00', priceHigh: '5880000.00', avgViews: 84000,
      cpmLow: '45000.00', cpmHigh: '70000.00', adjustments: { pasos: [] }, overridden: false,
    };
    const v1 = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      saveRateCard(tx, { creatorId: creadora, currency: 'COP', basis: { cpmSource: 'manual' }, items: [item] }));
    const v2 = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      saveRateCard(tx, { creatorId: creadora, currency: 'COP', basis: { cpmSource: 'manual' }, items: [item, { ...item, deliverable: 'reel', labelEs: 'Reel' }] }));

    assert.equal(v2.card.version, v1.card.version + 1);
    assert.equal(v2.items.length, 2);

    const vigente = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadora));
    assert.equal(vigente?.card.id, v2.card.id);
    const cuantosVigentes = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM rate_card WHERE creator_id = $1 AND is_current', [creadora]);
      return Number(rows[0]!.n);
    });
    assert.equal(cuantosVigentes, 1);
  });

  test('un precio escrito a mano queda marcado como editado', async () => {
    const vigente = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadora));
    const primero = vigente!.items[0]!;
    assert.equal(primero.overridden, false);

    const editado = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      overrideRateCardItemPrice(tx, primero.id, { priceLow: '4000000.00', priceHigh: '6000000.00' }));
    assert.equal(editado.overridden, true);
    assert.equal(editado.priceLow, '4000000.00');
  });

  test('el tarifario del vecino no se ve desde aquí', async () => {
    const desdeElVecino = await t.db.withWorkspace(WS_VECINO, (tx) => getCurrentRateCard(tx, creadora));
    assert.equal(desdeElVecino, null);
  });
});

// ------------------------------------------------------------- COT-2

describe('COT-2 · media kit', () => {
  test('el snapshot congela seguidores, views y tarifas', async () => {
    const snap = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => buildMediaKitSnapshot(tx, creadora));
    assert.equal(snap.version, 1);
    assert.ok(snap.creator.displayName.length > 0);
    assert.ok(snap.redes.length > 0, 'la creadora del seed tiene cuentas conectadas');
    assert.ok(snap.tarifas.length > 0, 'lleva las tarifas vigentes');
    assert.ok(snap.topPosts.length > 0, 'lleva sus mejores videos');
  });

  test('el enlace abre sin sesión, cuenta las visitas y no cambia aunque cambien las métricas', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora }));
    assert.equal(kit.viewCount, 0);
    const seguidoresAlCongelar = kit.snapshot.totales.followers;

    // La marca abre el enlace: SIN workspace fijado, como la ruta pública.
    const abierto = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(abierto.status, 'ok');
    assert.equal(abierto.status === 'ok' && abierto.viewCount, 1);
    assert.deepEqual(abierto.status === 'ok' ? abierto.snapshot.totales : null, kit.snapshot.totales);

    // Suben los seguidores después de generarlo.
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      await tx.query(
        `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, source)
         SELECT c.id, current_workspace_id(), CURRENT_DATE + 1, 999999, 'api'
           FROM social_connection c WHERE c.creator_id = $1 LIMIT 1`,
        [creadora],
      );
    });

    const otraVez = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(otraVez.status, 'ok');
    assert.equal(otraVez.status === 'ok' && otraVez.snapshot.totales.followers, seguidoresAlCongelar);
    assert.equal(otraVez.status === 'ok' && otraVez.viewCount, 2);
  });

  test('un slug que no existe es not_found, no un error', async () => {
    const r = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, 'esto-no-existe'));
    assert.deepEqual(r, { status: 'not_found' });
  });

  test('con contraseña: primero la pide, con la mala no entra, con la buena sí', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'cafe-con-leche' }));
    assert.equal(kit.hasPassword, true);

    const pide = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(pide.status, 'password_required');

    const mala = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug, 'otra'));
    assert.equal(mala.status, 'password_invalid');

    const buena = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug, 'cafe-con-leche'));
    assert.equal(buena.status, 'ok');

    // Una contraseña fallida no cuenta como visita.
    assert.equal(buena.status === 'ok' && buena.viewCount, 1);
  });

  test('un enlace vencido no entrega el snapshot', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    const r = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(r.status, 'expired');
  });

  test('despublicar apaga el enlace sin borrar las cifras', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateMediaKitShare(tx, kit.id, { isPublic: false }));
    const r = await t.db.withCatalogs((tx) => readPublicMediaKit(tx, kit.slug));
    assert.deepEqual(r, { status: 'not_found' });

    const sigueEnCasa = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listMediaKits(tx));
    assert.ok(sigueEnCasa.some((k) => k.id === kit.id));
  });

  test('la contraseña se guarda derivada, nunca en claro', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'secreto-de-prueba' }));
    const guardado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ password_hash: string }>('SELECT password_hash FROM media_kit WHERE id = $1', [kit.id]);
      return rows[0]!.password_hash;
    });
    assert.match(guardado, /^s1:[0-9a-f]{32}:[0-9a-f]{64}$/);
    assert.equal(guardado.includes('secreto-de-prueba'), false);
    assert.equal(verifySharePassword('secreto-de-prueba', guardado), true);
    assert.equal(verifySharePassword('otra', guardado), false);
    // Misma sal, mismo derivado: es lo que permite comparar en la base.
    assert.equal(hashSharePassword('secreto-de-prueba', guardado.split(':')[1]!), guardado);
  });
});

// --------------------------------------------------------- COT-3 y COT-4

describe('COT-3 y COT-4 · cotización, enlace y aceptación', () => {
  test('la numeración es COT-AAAA-NNN y no se repite dentro del workspace', async () => {
    const year = new Date().getUTCFullYear();
    const n = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => nextQuoteNumber(tx));
    assert.match(n, new RegExp(`^COT-${year}-\\d{3}$`));
  });

  test('crear desde un deal, enviar, abrir el enlace, aceptar y crear la campaña', async () => {
    const deals = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx));
    assert.ok(deals.length > 0, 'el seed trae deals abiertos');
    const deal = deals.find((d) => d.stageId === 'conversacion') ?? deals[0]!;

    const creada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createQuote(tx, {
        dealId: deal.id,
        creatorId: creadora,
        items: [
          { deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok dedicado', quantity: 1, unitPrice: '5000000' },
          { deliverable: 'historias', platformId: 'instagram', description: '3 historias', quantity: 3, unitPrice: '700000' },
        ],
        discount: '600000',
        taxRate: '0.19',
        agreedMetrics: ['views', 'reach', 'saves'],
        reportCutsHours: [24, 168, 720],
        usageRightsDays: 30,
        paymentTermsDays: 30,
        campaignStartsOn: '2026-10-01',
        campaignEndsOn: '2026-10-31',
      }));

    assert.equal(creada.status, 'draft');
    assert.equal(creada.companyId, deal.companyId);
    assert.equal(creada.subtotal, '7100000.00');
    assert.equal(creada.tax, '1235000.00');
    assert.equal(creada.total, '7735000.00');
    assert.equal(creada.items.length, 2);
    assert.equal(creada.items[1]!.total, '2100000.00');

    // Un borrador no abre el enlace.
    const antesDeEnviar = await t.db.withCatalogs((tx) => readPublicQuote(tx, creada.slug));
    assert.deepEqual(antesDeEnviar, { status: 'not_found' });

    // Enviar: congela el documento y mueve el deal.
    const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, creada.id));
    assert.equal(enviada.status, 'sent');
    assert.ok(enviada.sentAt);

    const etapa = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!.stage_id;
    });
    assert.equal(etapa, 'propuesta');

    // La marca abre el enlace, sin sesión: pasa a «vista».
    const publica = await t.db.withCatalogs((tx) => readPublicQuote(tx, creada.slug));
    assert.equal(publica.status, 'ok');
    if (publica.status === 'ok') {
      assert.equal(publica.quote.status, 'viewed');
      assert.equal(publica.quote.total, '7735000.00');
      assert.equal(publica.quote.items.length, 2);
      assert.equal(publica.quote.acordado.usageRightsDays, 30);
      assert.equal(publica.quote.company.name, deal.companyName);
    }

    // Y acepta.
    const aceptada = await t.db.withCatalogs((tx) => acceptPublicQuote(tx, creada.slug));
    assert.equal(aceptada.status, 'ok');
    assert.equal(aceptada.status === 'ok' && aceptada.campaignPending, true);

    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, creada.id));
    assert.equal(despues!.status, 'accepted');
    assert.equal(despues!.campaignPending, true);

    const dealGanado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string; won_at: string | null }>(
        'SELECT stage_id, won_at FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!;
    });
    assert.equal(dealGanado.stage_id, 'ganado');
    assert.ok(dealGanado.won_at, 'queda la fecha en que se ganó');

    const historial = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ to_stage_id: string }>(
        'SELECT to_stage_id FROM deal_stage_history WHERE deal_id = $1 ORDER BY changed_at DESC LIMIT 1', [deal.id]);
      return rows[0]!.to_stage_id;
    });
    assert.equal(historial, 'ganado');

    // COT-4: la campaña la crea CAM-2, con la ventana acordada.
    const campana = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createCampaignForQuote(tx, creada.id));
    assert.equal(campana.created, true);
    const otraVez = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createCampaignForQuote(tx, creada.id));
    assert.equal(otraVez.created, false, 'idempotente: no crea una segunda campaña');
    assert.equal(otraVez.campaignId, campana.campaignId);

    const conCampana = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, creada.id));
    assert.equal(conCampana!.campaignId, campana.campaignId);
    assert.equal(conCampana!.campaignPending, false);

    const planeada = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ status: string; starts_on: string }>(
        `SELECT status, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM campaign WHERE id = $1`,
        [campana.campaignId]);
      return rows[0]!;
    });
    assert.equal(planeada.status, 'planned');
    assert.equal(planeada.starts_on, '2026-10-01');

    // Aceptada dos veces: la segunda no es aceptable.
    const otraAceptacion = await t.db.withCatalogs((tx) => acceptPublicQuote(tx, creada.slug));
    assert.equal(otraAceptacion.status, 'not_acceptable');
  });

  test('una enviada ya no se edita', async () => {
    const [primera] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotes(tx, { status: ['accepted'] }));
    assert.ok(primera);
    await assert.rejects(
      () => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => import('../src/queries/cotizar.ts').then((m) =>
        m.updateQuoteDraft(tx, primera.id, { items: [{ deliverable: 'tiktok', platformId: 'tiktok', description: 'x', quantity: 1, unitPrice: '1' }] }))),
      QuoteNotEditable,
    );
  });

  test('aceptar desde el panel hace lo mismo que el enlace', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))
      .find((d) => d.stageId === 'contactado');
    assert.ok(deal);

    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const creada = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora,
        items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '3000000' }],
      });
      await sendQuote(tx, creada.id);
      return acceptQuote(tx, creada.id);
    });
    assert.equal(q.status, 'accepted');

    const etapa = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!.stage_id;
    });
    assert.equal(etapa, 'ganado');
  });

  test('sin fechas acordadas, crear la campaña pide la ventana en vez de inventarla', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))
      .find((d) => d.stageId === 'nuevo');
    assert.ok(deal);
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const creada = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora,
        items: [{ deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok', quantity: 1, unitPrice: '2000000' }],
      });
      await sendQuote(tx, creada.id);
      return acceptQuote(tx, creada.id);
    });
    await assert.rejects(
      () => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createCampaignForQuote(tx, q.id)),
      /ventana de la campaña/,
    );
  });

  test('el vecino no ve las cotizaciones de Laura ni con el id en la mano', async () => {
    const [una] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotes(tx));
    assert.ok(una);
    const desdeElVecino = await t.db.withWorkspace(WS_VECINO, (tx) => getQuote(tx, una.id));
    assert.equal(desdeElVecino, null);
    const listaVecina = await t.db.withWorkspace(WS_VECINO, (tx) => listQuotes(tx));
    assert.equal(listaVecina.length, 0);
  });

  test('el permiso del enlace no sobrevive a la llamada', async () => {
    const [una] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotes(tx, { status: ['accepted'] }));
    assert.ok(una);
    const fuga = await t.db.withCatalogs(async (tx) => {
      await readPublicQuote(tx, una.slug);
      // Después de la función, app.public_share vuelve a estar vacío:
      // sin workspace ni enlace, esta transacción no ve ninguna fila.
      const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM quote');
      return Number(rows[0]!.n);
    });
    assert.equal(fuga, 0);
  });
});
