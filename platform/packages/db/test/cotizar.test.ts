/**
 * Cotizar de punta a punta sobre Postgres embebido con el seed, como
 * mc_app y sin red: tarifario, media kit congelado, cotización con su
 * enlace público, aceptación y campaña.
 *
 * Lo que de verdad se comprueba aquí y no se puede comprobar en
 * packages/core:
 *   - que el enlace público abra SIN workspace fijado (withPublicShare),
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
  calcularItem, calcularPaquete, redondearParaNegociar,
  type ComponentePaquete, type FuenteViews, type PasoCalculo, type PlatformId,
} from '@mc/core';
import {
  acceptPublicQuote, acceptQuote, acceptQuoteAndCreateCampaign, buildMediaKitSnapshot, completePublicAcceptance,
  createMediaKit, createQuote, createCampaignForQuote, deleteQuoteDraft, getCurrentRateCard, getDefaultTaxRate,
  getMediaKitById, getQuote, getQuotePreview, getRateCardInputs, hashSharePassword, listMediaKits, listQuotableDeals, listQuotes,
  nextQuoteNumber, nuevoSlug, overrideRateCardItemPrice, readPublicMediaKit, readPublicQuote, rejectQuote,
  saveRateCard, sendQuote, unlockMediaKit, updateMediaKitShare, updateQuoteDraft, verifySharePassword, LARGO_SLUG,
  listAcceptanceNotices, markAcceptanceNoticeRead, listShareableMediaKits, terminosIncluidosEnTarifario,
  MediaKitNotFound, QuoteNotDraft, QuoteNotEditable, QuoteTransitionError, RangoDeTarifaInvalido, ValidezVencida,
  DealAlreadyAccepted, listMediaKitLockNotices, markMediaKitLockNoticeRead, notifyMediaKitLocked,
  type TextosCotizar,
} from '../src/queries/cotizar.ts';
import { DealLocked, FOLLOW_UP_ACTION, FOLLOW_UP_BUSINESS_DAYS, PITCH_ACTION, createCompany, createDeal, getCompany, getSalesKpis, moveDeal } from '../src/queries/ventas.ts';
import { openTestDb, WORKSPACE_LAURA, COMPANY_CAFE_ALMA, type TestDb } from './pglite.ts';

const WS_VECINO = '0000000c-0000-4000-8000-0000000000c1';
const FIRMA = { name: 'Ana Gómez', email: 'ana@cafealma.co' };

/**
 * Las frases que en la web salen de messages.ts. Aquí son marcas
 * reconocibles: la prueba comprueba que la base guarda lo que la web
 * compuso, y no una frase propia.
 */
const TEXTOS: TextosCotizar = {
  actividadEnviada: ({ quoteNumber }) => `[enviada] ${quoteNumber}`,
  actividadAceptada: ({ quoteNumber, signerName, via }) => `[aceptada:${via}] ${quoteNumber}${signerName ? ` ${signerName}` : ''}`,
  actividadMonto: ({ quoteNumber, amountFrom, amountTo, currencyTo }) => `[monto] ${quoteNumber} ${amountFrom ?? '-'} → ${amountTo} ${currencyTo}`,
  avisoAceptada: ({ companyName, quoteNumber, signerName, campaignName }) => ({
    title: `[aviso] ${companyName} ${quoteNumber}`,
    body: `${signerName ?? '-'} · ${campaignName ?? 'pendiente'}`,
  }),
};

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

// ------------------------- una sola convención de montos, y lo que sigue

describe('el mismo acuerdo dice lo mismo en Ventas, Cotizar y Campañas', () => {
  test('aceptar deja el negocio en el neto (subtotal − descuento) y la campaña en el total con impuesto', async () => {
    // La convención (0031, CAM-2 y CIM-6): el negocio es lo que la marca
    // presupuesta sin IVA; la campaña y la factura, lo que se cobra.
    const companyId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createCompany(tx, { name: 'Marca Convención', domain: 'marcaconvencion.co', relationship: 'prospect' }));
    const dealId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createDeal(tx, { companyId, name: 'Paquete convención', amount: '8000000' }));
    const creada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0.19', discount: '500000',
        items: [
          { deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok', quantity: 2, unitPrice: '2500000' },
          { deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '1500000' },
        ],
        campaignStartsOn: '2026-12-01', campaignEndsOn: '2026-12-10',
      }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, creada.id, TEXTOS));
    const { quote, campaign } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      acceptQuoteAndCreateCampaign(tx, creada.id, TEXTOS));
    assert.ok(campaign, 'con ventana acordada nace la campaña');

    const fila = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ deal: string; campana: string; neto: string; total: string }>(
        `SELECT d.amount::text AS deal, c.amount::text AS campana,
                (q.subtotal - q.discount)::text AS neto, q.total::text AS total
           FROM quote q JOIN deal d ON d.id = q.deal_id JOIN campaign c ON c.quote_id = q.id
          WHERE q.id = $1`, [quote.id]);
      return rows[0]!;
    });
    assert.equal(quote.subtotal, '6500000.00');
    assert.equal(fila.neto, '6000000.00');
    assert.equal(fila.deal, fila.neto, 'deal.amount = quote.subtotal − quote.discount');
    assert.equal(fila.total, '7140000.00');
    assert.equal(fila.campana, fila.total, 'campaign.amount = quote.total');

    // Y la marca, que era «Prospecto», queda como cliente al ganarse.
    const empresa = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCompany(tx, companyId));
    assert.equal(empresa?.relationship, 'client');
  });

  test('aceptar desde el enlace también hace cliente a la marca', async () => {
    const companyId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createCompany(tx, { name: 'Marca Enlace', domain: 'marcaenlace.co', relationship: 'contacted' }));
    const dealId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createDeal(tx, { companyId, name: 'Por enlace' }));
    const creada = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const q = await createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0.19',
        items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '2000000' }],
      });
      return sendQuote(tx, q.id, TEXTOS);
    });
    const aceptada = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, creada.slug, FIRMA));
    assert.equal(aceptada.status, 'ok');
    if (aceptada.status !== 'ok') return;
    // public_quote_accept no puede escribir company_link: lo hace el servidor al terminar.
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCompany(tx, companyId)))?.relationship, 'contacted');
    await t.db.withWorkspace(aceptada.workspaceId, (tx) => completePublicAcceptance(tx, creada.id, TEXTOS));
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCompany(tx, companyId)))?.relationship, 'client');
  });

  test('enviar la cotización cambia «Enviar pitch» por «Seguimiento a la cotización» a tres días hábiles', async () => {
    const dealId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Con pitch pendiente' }));
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ next_action: string }>('SELECT next_action FROM deal WHERE id = $1', [dealId])).rows[0]!);
    assert.equal(antes.next_action, PITCH_ACTION);

    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const q = await createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0.19',
        items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '1000000' }],
      });
      await sendQuote(tx, q.id, TEXTOS);
    });
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ next_action: string; hora: number; dow: number; habiles: number }>(
        `SELECT d.next_action,
                extract(hour FROM d.next_action_due AT TIME ZONE 'America/Bogota')::int AS hora,
                extract(isodow FROM d.next_action_due AT TIME ZONE 'America/Bogota')::int AS dow,
                (SELECT count(*)::int
                   FROM generate_series((now() AT TIME ZONE 'America/Bogota')::date + 1,
                                        (d.next_action_due AT TIME ZONE 'America/Bogota')::date, interval '1 day') AS dia
                  WHERE extract(isodow FROM dia) < 6) AS habiles
           FROM deal d WHERE d.id = $1`, [dealId])).rows[0]!);
    assert.equal(despues.next_action, FOLLOW_UP_ACTION, 'el pitch ya se superó con una propuesta');
    assert.equal(despues.hora, 15, 'a las 15:00 en la zona del workspace');
    assert.ok(despues.dow <= 5, 'vence un día hábil');
    assert.equal(despues.habiles, FOLLOW_UP_BUSINESS_DAYS);
  });

  test('una siguiente acción escrita a mano se respeta, y el texto nuevo lo pone la pantalla', async () => {
    // «A mano» es una siguiente acción que la persona REESCRIBIÓ después
    // de abrir el negocio: el disparador de 0032 le quita el marcador de
    // pitch. La que nace en otro idioma sigue siendo el pitch (marcador
    // 'pitch'), diga lo que diga su frase.
    const [aMano, conPitch] = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const llamada = await createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Con llamada' });
      await tx.query(`UPDATE deal SET next_action = 'Llamar a Valentina' WHERE id = $1`, [llamada]);
      return [llamada, await createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Con pitch en otro idioma', nextAction: 'Send pitch' })];
    });
    const textos: TextosCotizar = { ...TEXTOS, accionSeguimiento: 'Follow up on the quote', accionesSuperadas: ['Send pitch'] };
    for (const dealId of [aMano, conPitch]) {
      await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
        const q = await createQuote(tx, {
          dealId, creatorId: creadora, taxRate: '0',
          items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '1000000' }],
        });
        await sendQuote(tx, q.id, textos);
      });
    }
    const acciones = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ id: string; next_action: string }>('SELECT id, next_action FROM deal WHERE id = ANY($1::uuid[])', [[aMano, conPitch]])).rows);
    const por = new Map(acciones.map((a) => [a.id, a.next_action]));
    assert.equal(por.get(aMano), 'Llamar a Valentina');
    assert.equal(por.get(conPitch), 'Follow up on the quote');
  });
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

  test('con las views REALES del seed, el rango es del orden del mock y se mueve con el CPM', async () => {
    const inputs = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getRateCardInputs(tx, creadora)))!;
    // El Reel: la mediana de Instagram del seed y el CPM de cocina en CO.
    const base = inputs.baselines.find((b) => b.platformId === 'instagram');
    const cpm = inputs.benchmarks.find((b) => b.platform === 'instagram');
    assert.ok(base && cpm, 'el seed trae línea base y CPM de Instagram');
    const entrada = {
      deliverable: 'reel', platformId: 'instagram' as const, cantidad: 1,
      views: base.medianViews, viewsSource: 'baseline' as const,
      cpmLow: cpm.cpmLow, cpmHigh: cpm.cpmHigh, cpmSource: cpm.source,
      nicheSlug: cpm.nicheSlug, country: cpm.country, currency: inputs.currency,
    };
    const item = calcularItem(entrada);
    // El mock pone el Reel en COP 4,8 – 7,2 millones (92 K views). Con
    // las views del seed tiene que caer en el mismo orden: millones de
    // pesos, no miles ni cientos de millones.
    for (const v of [item.priceLow, item.priceHigh]) {
      assert.ok(Number(v) >= 1_000_000 && Number(v) <= 20_000_000, `${v} está en el orden del mock`);
    }
    assert.ok(Number(item.priceLow) < Number(item.priceHigh));

    // Cambiar el CPM cambia el rango y la explicación lo dice.
    const otro = calcularItem({ ...entrada, cpmLow: '60000', cpmHigh: '90000', cpmSource: 'creador' });
    assert.notEqual(otro.priceLow, item.priceLow);
    assert.deepEqual(otro.pasos.find((p) => p.tipo === 'cpm'), {
      tipo: 'cpm', cpmLow: '60000.00', cpmHigh: '90000.00', fuente: 'creador',
      nicheSlug: cpm.nicheSlug, country: cpm.country, platformId: 'instagram',
    });
  });

  test('un rango al revés, vacío o en cero no llega a la base', async () => {
    const item = {
      deliverable: 'reel', platformId: 'instagram' as const, labelEs: 'Reel',
      priceLow: '9000000.00', priceHigh: '1000000.00', avgViews: null,
      cpmLow: null, cpmHigh: null, adjustments: {}, overridden: true,
    };
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadora));
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => saveRateCard(tx, { creatorId: creadora, currency: 'COP', basis: {}, items: [item] })),
      (err: unknown) => err instanceof RangoDeTarifaInvalido && err.code === 'RangoInvertido' && err.deliverable === 'reel',
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        saveRateCard(tx, { creatorId: creadora, currency: 'COP', basis: {}, items: [{ ...item, priceLow: '0', priceHigh: '0' }] })),
      (err: unknown) => err instanceof RangoDeTarifaInvalido && err.code === 'RangoEnCero',
    );
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadora));
    assert.equal(despues?.card.id, antes?.card.id, 'no se guardó ninguna versión a medias');

    const primero = despues!.items[0]!;
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => overrideRateCardItemPrice(tx, primero.id, { priceLow: '9000000.00', priceHigh: '1.00' })),
      RangoDeTarifaInvalido,
    );

    // Y si alguien escribe sin pasar por las consultas, el CHECK de 0030 lo para.
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        tx.query('UPDATE rate_card_item SET price_low = 9000000, price_high = 1 WHERE id = $1', [primero.id])),
      /rate_card_item_price_range_check/,
    );
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
    assert.equal(snap.version, 2);
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
    const abierto = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug));
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

    const otraVez = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(otraVez.status, 'ok');
    assert.equal(otraVez.status === 'ok' && otraVez.snapshot.totales.followers, seguidoresAlCongelar);
    assert.equal(otraVez.status === 'ok' && otraVez.viewCount, 2);
  });

  test('la audiencia va agrupada: una red, una entrada por dimensión, sin repetir segmentos', async () => {
    const snap = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => buildMediaKitSnapshot(tx, creadora));
    assert.ok(snap.audiencia.length > 0, 'el seed trae demografía');
    const redes = new Set(snap.audiencia.map((a) => a.platformId));
    assert.equal(redes.size, 1, 'una sola red: la principal');
    const dimensiones = snap.audiencia.map((a) => a.dimension);
    assert.deepEqual(dimensiones, [...new Set(dimensiones)], 'cada dimensión aparece una vez');
    assert.equal(dimensiones[0], 'age', 'la edad primero');
    for (const a of snap.audiencia) {
      const buckets = a.buckets.map((b) => b.bucket);
      assert.deepEqual(buckets, [...new Set(buckets)], `sin segmentos repetidos en ${a.dimension}`);
    }
    const edad = snap.audiencia.find((a) => a.dimension === 'age')!;
    assert.deepEqual(edad.buckets.map((b) => b.bucket), [...edad.buckets.map((b) => b.bucket)].sort(), 'la edad en orden de edad');
  });

  test('la vista previa del panel no cuenta como visita', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora }));
    const previa = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, null, { count: false }));
    assert.equal(previa.status, 'ok');
    assert.equal(previa.status === 'ok' && previa.viewCount, 0);
    const marca = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(marca.status === 'ok' && marca.viewCount, 1);
  });

  test('un slug que no existe es not_found, no un error', async () => {
    const r = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, 'esto-no-existe'));
    assert.deepEqual(r, { status: 'not_found' });
  });

  test('con contraseña: primero la pide, con la mala no entra, con la buena sí', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'cafe-con-leche' }));
    assert.equal(kit.hasPassword, true);

    const pide = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(pide.status, 'password_required');

    const mala = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'otra'));
    assert.equal(mala.status, 'password_invalid');
    assert.equal(mala.status === 'password_invalid' && mala.attemptsLeft, 9);

    const buena = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'cafe-con-leche'));
    assert.equal(buena.status, 'ok');

    // Una contraseña fallida no cuenta como visita.
    assert.equal(buena.status === 'ok' && buena.viewCount, 1);
  });

  test('diez contraseñas fallidas bloquean ESE origen quince minutos, también con la buena', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'la-buena' }));
    const atacante = { origin: '203.0.113.7' };
    let ultimo = '';
    for (let i = 0; i < 10; i++) {
      const r = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, `mala-${i}`, atacante));
      ultimo = r.status;
    }
    assert.equal(ultimo, 'locked');
    const conLaBuena = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', atacante));
    assert.equal(conLaBuena.status, 'locked');
    const soloAbrir = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, null, atacante));
    assert.equal(soloAbrir.status, 'locked', 'recargar la página desde el mismo origen sigue bloqueado');

    // La marca, desde otro origen, ni se entera: el bloqueo no es del enlace.
    const marca = { origin: '198.51.100.20' };
    const pide = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, null, marca));
    assert.equal(pide.status, 'password_required');
    const entra = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', marca));
    assert.equal(entra.status, 'ok');

    // Pasado el bloqueo, el origen bloqueado entra con la buena y su cuenta desaparece.
    await t.admin(`UPDATE media_kit_lockout SET locked_until = now() - interval '1 second' WHERE media_kit_id = '${kit.id}'`);
    const despues = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', atacante));
    assert.equal(despues.status, 'ok');
    const libre = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getMediaKitById(tx, kit.id));
    assert.equal(libre?.lockedOrigins, 0);
    await t.admin(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM media_kit_lockout WHERE media_kit_id = '${kit.id}') THEN
        RAISE EXCEPTION 'el acierto no borró la cuenta del origen';
      END IF; END $$`);
  });

  test('el origen se guarda resumido, nunca la IP', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'la-buena' }));
    await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'mala', { origin: '203.0.113.99' }));
    // Una sola fila, y lo guardado es sha256(id del kit | IP) en hex.
    await t.admin(`DO $$ BEGIN
      IF (SELECT count(*) FROM media_kit_lockout WHERE media_kit_id = '${kit.id}') <> 1
         OR NOT EXISTS (SELECT 1 FROM media_kit_lockout
                         WHERE media_kit_id = '${kit.id}'
                           AND origin_hash = encode(sha256(convert_to('${kit.id}|203.0.113.99', 'UTF8')), 'hex')) THEN
        RAISE EXCEPTION 'el origen no se guardó como su resumen';
      END IF; END $$`);

    // Y el creador (mc_app) no puede leer ese resumen: solo contar y borrar.
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      try {
        await tx.query('SELECT origin_hash FROM media_kit_lockout');
        return 'leyó';
      } catch (err) {
        return (err as Error).message;
      }
    });
    assert.match(r, /permission denied/);
  });

  test('cincuenta fallos en una hora, repartidos entre orígenes, bloquean el enlace entero', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'la-buena' }));
    // Nueve por origen: ninguno llega a su propio bloqueo.
    let ultimo = '';
    for (let o = 0; o < 6 && ultimo !== 'locked'; o++) {
      for (let i = 0; i < 9 && ultimo !== 'locked'; i++) {
        const r = await t.db.withPublicShare((tx) =>
          readPublicMediaKit(tx, kit.slug, `mala-${o}-${i}`, { origin: `192.0.2.${o}` }));
        ultimo = r.status;
      }
    }
    assert.equal(ultimo, 'locked');
    const otro = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', { origin: '198.51.100.1' }));
    assert.equal(otro.status, 'locked', 'el techo del enlace vale para todos los orígenes');

    // El creador lo ve en su lista, y «Desbloquear» lo pone a cero.
    const enLaLista = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getMediaKitById(tx, kit.id));
    assert.ok(enLaLista?.lockedUntil, 'la lista dice hasta cuándo');
    const libre = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => unlockMediaKit(tx, kit.id));
    assert.equal(libre.lockedUntil, null);
    assert.equal(libre.lockedOrigins, 0);
    const entra = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', { origin: '198.51.100.1' }));
    assert.equal(entra.status, 'ok');
  });

  test('el creador ve cuántos orígenes están bloqueados y los desbloquea', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, password: 'la-buena' }));
    const marca = { origin: '198.51.100.30' };
    for (let i = 0; i < 10; i++) {
      await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, `mala-${i}`, marca));
    }
    const visto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getMediaKitById(tx, kit.id));
    assert.equal(visto?.lockedOrigins, 1);
    assert.equal(visto?.lockedUntil, null, 'el enlace sigue abierto para los demás');

    // Otro workspace no desbloquea lo que no ve.
    await assert.rejects(
      t.db.withWorkspace(WS_VECINO, (tx) => unlockMediaKit(tx, kit.id)),
      MediaKitNotFound,
    );

    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => unlockMediaKit(tx, kit.id));
    const entra = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', marca));
    assert.equal(entra.status, 'ok');
  });

  test('un enlace vencido no entrega el snapshot', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createMediaKit(tx, { creatorId: creadora, expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    const r = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug));
    assert.equal(r.status, 'expired');
  });

  test('despublicar apaga el enlace sin borrar las cifras', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateMediaKitShare(tx, kit.id, { isPublic: false }));
    const r = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug));
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
    assert.equal(await verifySharePassword('secreto-de-prueba', guardado), true);
    assert.equal(await verifySharePassword('otra', guardado), false);
    // Misma sal, mismo derivado: es lo que permite comparar en la base.
    assert.equal(await hashSharePassword('secreto-de-prueba', guardado.split(':')[1]!), guardado);
  });

  test('el slug tiene 26 signos del alfabeto sin parecidos', () => {
    const slugs = Array.from({ length: 200 }, () => nuevoSlug());
    for (const s of slugs) {
      assert.equal(s.length, LARGO_SLUG);
      assert.match(s, /^[23456789abcdefghjkmnpqrstuvwxyz]+$/);
    }
    assert.equal(new Set(slugs).size, slugs.length);
  });
});

// --------------------------------------------------------- COT-3 y COT-4

describe('COT-3 y COT-4 · cotización, enlace y aceptación', () => {
  test('la numeración es COT-AAAA-NNN y no se repite dentro del workspace', async () => {
    const year = new Date().getUTCFullYear();
    const n = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => nextQuoteNumber(tx));
    assert.match(n, new RegExp(`^COT-(${year - 1}|${year}|${year + 1})-\\d{3}$`));
  });

  test('el año de la numeración es el de la zona del workspace, no el de UTC', async () => {
    // 1 de enero de 2027 a la 01:00 UTC es 31 de diciembre de 2026 a las
    // 20:00 en Bogotá: esa cotización es de 2026.
    const zona = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ timezone: string }>('SELECT timezone FROM workspace WHERE id = $1', [tx.workspaceId]);
      return rows[0]!.timezone;
    });
    assert.equal(zona, 'America/Bogota');
    const n = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => nextQuoteNumber(tx, { at: new Date('2027-01-01T01:00:00Z') }));
    assert.match(n, /^COT-2026-\d{3}$/);
    // Cinco horas y media más tarde en UTC, en Bogotá ya es 2027.
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => nextQuoteNumber(tx, { at: new Date('2027-01-01T05:30:00Z') }));
    assert.equal(despues, 'COT-2027-001');
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
    const antesDeEnviar = await t.db.withPublicShare((tx) => readPublicQuote(tx, creada.slug));
    assert.deepEqual(antesDeEnviar, { status: 'not_found' });

    // Enviar: congela el documento y mueve el deal.
    const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, creada.id, TEXTOS));
    assert.equal(enviada.status, 'sent');
    assert.ok(enviada.sentAt);

    const etapa = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!.stage_id;
    });
    assert.equal(etapa, 'propuesta');

    // Y el monto del negocio pasa a ser el neto de la cotización:
    // subtotal 7,1 M − descuento 0,6 M = 6,5 M, sin el IVA (0031).
    const montoEnviado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ amount: string; currency: string }>(
        'SELECT amount::text AS amount, currency::text AS currency FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!;
    });
    assert.deepEqual(montoEnviado, { amount: '6500000.00', currency: 'COP' });

    // La marca abre el enlace, sin sesión: pasa a «vista».
    const publica = await t.db.withPublicShare((tx) => readPublicQuote(tx, creada.slug));
    assert.equal(publica.status, 'ok');
    if (publica.status === 'ok') {
      assert.equal(publica.quote.status, 'viewed');
      assert.equal(publica.quote.total, '7735000.00');
      assert.equal(publica.quote.items.length, 2);
      assert.equal(publica.quote.acordado.usageRightsDays, 30);
      assert.equal(publica.quote.company.name, deal.companyName);
    }

    // Sin nombre o con un correo que no es correo, no acepta.
    const sinFirma = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, creada.slug, { name: ' ', email: 'x' }));
    assert.deepEqual(sinFirma, { status: 'invalid_signer' });

    // Y acepta, con nombre y correo. El workspace lo dice la base.
    const aceptada = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, creada.slug, FIRMA));
    assert.equal(aceptada.status, 'ok');
    assert.equal(aceptada.status === 'ok' && aceptada.workspaceId, WORKSPACE_LAURA);

    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, creada.id));
    assert.equal(despues!.status, 'accepted');
    assert.equal(despues!.acceptedByName, FIRMA.name);
    assert.equal(despues!.acceptedByEmail, FIRMA.email);
    assert.equal(despues!.campaignPending, true, 'hasta que el servidor termina la aceptación');

    const dealGanado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string; won_at: string | null }>(
        'SELECT stage_id, won_at FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!;
    });
    assert.equal(dealGanado.stage_id, 'ganado');
    assert.ok(dealGanado.won_at, 'queda la fecha en que se ganó');
    assert.equal(aceptada.status === 'ok' && aceptada.dealAmountChanged, false, 'el monto ya era el de la cotización');

    const historial = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ to_stage_id: string }>(
        'SELECT to_stage_id FROM deal_stage_history WHERE deal_id = $1 ORDER BY changed_at DESC LIMIT 1', [deal.id]);
      return rows[0]!.to_stage_id;
    });
    assert.equal(historial, 'ganado');

    // COT-4: el servidor termina la aceptación con ESE workspace: la
    // campaña la crea CAM-2 con la ventana acordada, y queda el aviso.
    const terminada = await t.db.withWorkspace(
      aceptada.status === 'ok' ? aceptada.workspaceId : '',
      (tx) => completePublicAcceptance(tx, creada.id, TEXTOS),
    );
    assert.equal(terminada.pendingReason, null);
    const campana = terminada.campaign!;
    assert.equal(campana.created, true);
    const aviso = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ kind: string; title_es: string; body_es: string }>(
        "SELECT kind, title_es, body_es FROM notification WHERE entity_id = $1", [creada.id]);
      return rows;
    });
    assert.equal(aviso.length, 1);
    assert.equal(aviso[0]!.kind, 'quote_accepted');
    // La frase es la que compuso la web (TEXTOS), con la campaña ya creada.
    assert.equal(aviso[0]!.title_es, `[aviso] ${deal.companyName} ${creada.number}`);
    assert.equal(aviso[0]!.body_es, `Ana Gómez · ${campana.campaignName}`);
    // La campaña se llama como el negocio, no «marca · primer entregable».
    assert.equal(campana.campaignName, deal.name);

    // La historia del negocio: frases de la web, y en metadata el código
    // y los parámetros para recomponerlas.
    const actividades = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ subject: string; metadata: Record<string, unknown> }>(
        'SELECT subject, metadata FROM activity WHERE deal_id = $1 ORDER BY occurred_at, subject', [deal.id]);
      return rows;
    });
    const enviadaAct = actividades.find((a) => a.metadata.kind === 'quote_sent');
    const aceptadaAct = actividades.find((a) => a.metadata.kind === 'quote_accepted');
    assert.equal(enviadaAct?.subject, `[enviada] ${creada.number}`);
    assert.equal(aceptadaAct?.subject, `[aceptada:enlace] ${creada.number} Ana Gómez`);
    assert.deepEqual(
      { ...aceptadaAct!.metadata },
      { kind: 'quote_accepted', quoteId: creada.id, quoteNumber: creada.number, signerName: FIRMA.name, signerEmail: FIRMA.email, via: 'enlace' },
    );

    // El aviso sale en la lista de cotizaciones hasta que se da por visto.
    const avisos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAcceptanceNotices(tx));
    const esteAviso = avisos.find((a) => a.quoteId === creada.id);
    assert.ok(esteAviso, 'el aviso se lista');
    assert.equal(esteAviso.signerName, FIRMA.name);
    assert.equal(esteAviso.campaignName, campana.campaignName);
    assert.deepEqual(await t.db.withWorkspace(WS_VECINO, (tx) => listAcceptanceNotices(tx)), [], 'el vecino no lo ve');
    await t.db.withWorkspace(WS_VECINO, (tx) => markAcceptanceNoticeRead(tx, esteAviso.id));
    assert.ok(
      (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAcceptanceNotices(tx))).some((a) => a.id === esteAviso.id),
      'el vecino no lo puede dar por visto',
    );
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markAcceptanceNoticeRead(tx, esteAviso.id));
    assert.equal(
      (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAcceptanceNotices(tx))).some((a) => a.id === esteAviso.id),
      false,
    );
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

    // Aceptada dos veces (otra pestaña): la segunda no es aceptable, y
    // dice por qué, para que la página no la llame «vencida».
    const otraAceptacion = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, creada.slug, FIRMA));
    assert.deepEqual(otraAceptacion, { status: 'not_acceptable', quoteStatus: 'accepted' });
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

  test('aceptar desde el panel gana el negocio y crea la campaña en la misma transacción', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))
      .find((d) => d.stageId === 'contactado');
    assert.ok(deal);

    const r = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const creada = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora,
        items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel', quantity: 1, unitPrice: '3000000' }],
        campaignStartsOn: '2026-11-02', campaignEndsOn: '2026-11-20',
      });
      await sendQuote(tx, creada.id, TEXTOS);
      return acceptQuoteAndCreateCampaign(tx, creada.id, TEXTOS);
    });
    assert.equal(r.quote.status, 'accepted');
    assert.equal(r.pendingReason, null);
    assert.ok(r.campaign?.created);
    assert.equal(r.quote.campaignId, r.campaign?.campaignId);
    assert.equal(r.quote.campaignPending, false);

    const etapa = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!.stage_id;
    });
    assert.equal(etapa, 'ganado');
    const monto = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ amount: string }>('SELECT amount::text AS amount FROM deal WHERE id = $1', [deal.id]);
      return rows[0]!.amount;
    });
    assert.equal(monto, '3000000.00', 'ganado con el neto de la cotización, no con el monto que traía');
  });

  test('sin fechas, aceptar desde el panel acepta igual y deja la campaña pendiente con su motivo', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))
      .find((d) => d.stageId !== 'contactado' && d.stageId !== 'conversacion');
    assert.ok(deal);
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const creada = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora,
        items: [{ deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok', quantity: 1, unitPrice: '1000000' }],
      });
      await sendQuote(tx, creada.id, TEXTOS);
      return acceptQuoteAndCreateCampaign(tx, creada.id, TEXTOS);
    });
    assert.equal(r.quote.status, 'accepted', 'el SAVEPOINT deshizo solo la campaña');
    assert.equal(r.campaign, null);
    assert.equal(r.pendingReason, 'FechasDeCampanaFaltan');
    assert.equal(r.quote.campaignPending, true);
  });

  test('sin fechas acordadas, crear la campaña pide la ventana en vez de inventarla', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))
      .find((d) => d.stageId === 'nuevo');
    assert.ok(deal);
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const creada = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora,
        items: [{ deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok', quantity: 1, unitPrice: '2000000' }],
        campaignStartsOn: null, campaignEndsOn: null,
      });
      await sendQuote(tx, creada.id, TEXTOS);
      return acceptQuote(tx, creada.id, TEXTOS);
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
    const fuga = await t.db.withPublicShare(async (tx) => {
      await readPublicQuote(tx, una.slug);
      // Después de la función, app.public_share vuelve a estar vacío:
      // sin workspace ni enlace, esta transacción no ve ninguna fila.
      const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM quote');
      return Number(rows[0]!.n);
    });
    assert.equal(fuga, 0);
  });
});

// ------------------------------------------------ la cerradura (0030)

describe('0030 · el enlace público corre con su propio rol', () => {
  test('la sonda: mc_app con el parámetro fijado a mano no ve ni escribe nada', async () => {
    const [una] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotes(tx, { status: ['accepted'] }));
    assert.ok(una);
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora }));

    const sonda = await t.db.withCatalogs(async (tx) => {
      await tx.query("SELECT set_config('app.public_share', $1, true)", [una.slug]);
      const quotes = await tx.query<{ n: string }>('SELECT count(*) AS n FROM quote');
      const deals = await tx.query<{ n: string }>('SELECT count(*) AS n FROM deal');
      const upd = await tx.query("UPDATE quote SET total = 1, status = 'accepted' WHERE slug = $1 RETURNING id", [una.slug]);
      const updDeal = await tx.query("UPDATE deal SET name = 'hackeado' RETURNING id");
      await tx.query("SELECT set_config('app.public_share', $1, true)", [kit.slug]);
      const kits = await tx.query<{ n: string }>('SELECT count(*) AS n FROM media_kit');
      const updKit = await tx.query("UPDATE media_kit SET snapshot = '{}'::jsonb RETURNING id");
      return {
        quotes: Number(quotes.rows[0]!.n), deals: Number(deals.rows[0]!.n), kits: Number(kits.rows[0]!.n),
        escritas: (upd.rows.length) + (updDeal.rows.length) + (updKit.rows.length),
      };
    });
    assert.deepEqual(sonda, { quotes: 0, deals: 0, kits: 0, escritas: 0 });

    // Y lo que había sigue intacto.
    const intacta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, una.id));
    assert.equal(intacta!.total, una.total);
  });

  test('mc_app no puede hacerse pasar por mc_public_share ni llamar al cuerpo de las funciones con permiso', async () => {
    // (Con pg_has_role y no con SET ROLE: en PGlite la sesión es del
    // superusuario, que puede cambiar a cualquier rol; en Supabase la
    // abre mc_app y lo que cuenta es su membresía.)
    const miembro = await t.db.withCatalogs(async (tx) => {
      const { rows } = await tx.query<{ m: boolean }>("SELECT pg_has_role('mc_app', 'mc_public_share', 'MEMBER') AS m");
      return rows[0]!.m;
    });
    assert.equal(miembro, false);
    const [una] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotes(tx, { status: ['accepted'] }));
    // Si el cuerpo se ejecutara como mc_app (SECURITY INVOKER), las
    // políticas del enlace no le aplican: no encuentra nada.
    const r = await t.db.withCatalogs(async (tx) => {
      try {
        const { rows } = await tx.query<{ r: { status: string } }>('SELECT public_quote_impl($1, false) AS r', [una!.slug]);
        return rows[0]!.r.status;
      } catch (err) {
        return (err as Error).message;
      }
    });
    assert.match(r, /not_found|permission denied/);
  });

  test('las funciones son de mc_public_share, un rol sin BYPASSRLS ni login', async () => {
    const filas = await t.db.withCatalogs(async (tx) => {
      const { rows } = await tx.query<{ proname: string; owner: string; secdef: boolean }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef
           FROM pg_proc p
          WHERE p.proname IN ('public_media_kit', 'public_quote', 'public_quote_accept')`);
      return rows;
    });
    assert.equal(filas.length, 3);
    for (const f of filas) {
      assert.equal(f.owner, 'mc_public_share', `${f.proname} es de mc_public_share`);
      assert.equal(f.secdef, true);
    }
    const rol = await t.db.withCatalogs(async (tx) => {
      const { rows } = await tx.query<{ rolbypassrls: boolean; rolcanlogin: boolean }>(
        "SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'mc_public_share'");
      return rows[0]!;
    });
    assert.deepEqual(rol, { rolbypassrls: false, rolcanlogin: false });
  });
});

// ----------------------------------------------- el ciclo, con fechas

describe('COT-3 · ciclo con fechas, borradores y estado de hoy', () => {
  async function dealAbierto() {
    const deals = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx));
    return deals[0]!;
  }
  const ITEM = { deliverable: 'tiktok', platformId: 'tiktok' as const, description: 'TikTok', quantity: 1, unitPrice: '1000000' };

  test('los negocios ganados o perdidos no se ofrecen para cotizar', async () => {
    const deals = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx));
    assert.ok(deals.length > 0);
    const etapas = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ id: string; is_won: boolean; is_lost: boolean }>(
        'SELECT id, is_won, is_lost FROM deal_pipeline WHERE id = ANY($1::uuid[])', [deals.map((d) => d.id)]);
      return rows;
    });
    assert.equal(etapas.some((e) => e.is_won || e.is_lost), false);
  });

  test('una cotización con la validez ya vencida no se envía: nacería vencida', async () => {
    const deal = await dealAbierto();
    const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM], validUntil: '2020-01-31' }));
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, c.id, TEXTOS)), ValidezVencida);
    const sigue = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, c.id));
    assert.equal(sigue!.status, 'draft', 'se queda en borrador para corregir la fecha');
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => deleteQuoteDraft(tx, c.id));
  });

  test('rechazar deja su fecha, y el enlace dice «rechazada», no «vencida»', async () => {
    const deal = await dealAbierto();
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM] });
      await sendQuote(tx, c.id, TEXTOS);
      return rejectQuote(tx, c.id);
    });
    assert.equal(q.status, 'rejected');
    assert.ok(q.rejectedAt);
    const aceptar = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, q.slug, FIRMA));
    assert.deepEqual(aceptar, { status: 'not_acceptable', quoteStatus: 'rejected' });
  });

  test('aceptada sin ventana, la campaña se crea después con las fechas que se den', async () => {
    const deal = await dealAbierto();
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM] });
      await sendQuote(tx, c.id, TEXTOS);
      return (await acceptQuoteAndCreateCampaign(tx, c.id, TEXTOS)).quote;
    });
    assert.equal(q.campaignPending, true);
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createCampaignForQuote(tx, q.id, { startsOn: '2026-12-10', endsOn: '2026-12-01' })),
      (err: unknown) => (err as { code?: string }).code === 'FinAntesDeInicio',
    );
    const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createCampaignForQuote(tx, q.id, { startsOn: '2026-12-01', endsOn: '2026-12-15' }));
    assert.equal(c.created, true);
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, q.id));
    assert.equal(despues!.campaignPending, false);
    assert.equal(despues!.campaignId, c.campaignId);
  });

  test('una enviada con la validez vencida sale vencida en el panel, sin que nadie abra el enlace', async () => {
    const deal = await dealAbierto();
    const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM], validUntil: '2099-12-31' });
      return sendQuote(tx, c.id, TEXTOS);
    });
    // Pasa el tiempo: la validez queda atrás sin que nadie abra el enlace.
    await t.admin(`UPDATE quote SET valid_until = '2020-01-31' WHERE id = '${enviada.id}'`);
    const q = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, enviada.id)))!;
    assert.equal(q.status, 'expired');
    assert.ok(q.expiredAt, 'con la fecha en que dejó de valer');
    const vencidas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotes(tx, { status: ['expired'] }));
    assert.ok(vencidas.some((x) => x.id === q.id));
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuote(tx, q.id, TEXTOS)), /vencida|expired/i);

    // El enlace la persiste con su fecha, y ya no se puede aceptar.
    const publica = await t.db.withPublicShare((tx) => readPublicQuote(tx, q.slug));
    assert.equal(publica.status === 'ok' && publica.quote.status, 'expired');
    const aceptar = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, q.slug, FIRMA));
    assert.equal(aceptar.status, 'not_acceptable');
  });

  test('un borrador se edita sin gastar otro número, y se borra', async () => {
    const deal = await dealAbierto();
    const creada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM], taxRate: '0.19' }));
    assert.equal(creada.taxRate, '0.19');
    const editada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateQuoteDraft(tx, creada.id, { items: [{ ...ITEM, quantity: 3 }], taxRate: '0.16' }));
    assert.equal(editada.number, creada.number);
    assert.equal(editada.subtotal, '3000000.00');
    assert.equal(editada.taxRate, '0.16');
    assert.equal(editada.tax, '480000.00');

    // La vista previa de un borrador no abre el enlace ni lo registra.
    const previa = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuotePreview(tx, creada.id));
    assert.equal(previa?.status, 'draft');
    assert.equal(previa?.total, editada.total);

    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => deleteQuoteDraft(tx, creada.id));
    const borrada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, creada.id));
    assert.equal(borrada, null);
  });

  test('una enviada no se borra', async () => {
    const deal = await dealAbierto();
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM] });
      return sendQuote(tx, c.id, TEXTOS);
    });
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => deleteQuoteDraft(tx, q.id)), QuoteNotDraft);
  });

  test('la vista previa de una enviada no la marca como vista ni suma visitas', async () => {
    const deal = await dealAbierto();
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM] });
      return sendQuote(tx, c.id, TEXTOS);
    });
    const previa = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuotePreview(tx, q.id));
    assert.equal(previa?.status, 'sent');
    const robot = await t.db.withPublicShare((tx) => readPublicQuote(tx, q.slug, { count: false }));
    assert.equal(robot.status === 'ok' && robot.quote.status, 'sent');
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, q.id));
    assert.equal(despues!.status, 'sent');
    assert.equal(despues!.viewCount, 0);
    assert.equal(despues!.viewedAt, null);
  });

  test('el impuesto por defecto sale del workspace: IVA en Colombia, cero donde no se sabe', async () => {
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getDefaultTaxRate(tx)), '0.19');
    assert.equal(await t.db.withWorkspace(WS_VECINO, (tx) => getDefaultTaxRate(tx)), '0');
    await t.admin(`UPDATE workspace SET settings = settings || '{"taxRate":"0.16"}' WHERE id = '${WS_VECINO}'`);
    assert.equal(await t.db.withWorkspace(WS_VECINO, (tx) => getDefaultTaxRate(tx)), '0.16');
  });
});

// ------------------------------- convivencia con el endurecimiento (0025)

// ------------------------------------------------ carreras y ronda 4

/**
 * El panel y el enlace a la vez. Sobre Postgres real (el job
 * «contra-postgres-real» del CI, con TEST_DATABASE_URL) las dos
 * transacciones corren de verdad en paralelo: la del enlace acepta y se
 * queda abierta con la fila bloqueada mientras el panel intenta
 * rechazar. Sin el FOR UPDATE de getQuoteForUpdate, el panel leía 'sent'
 * y su UPDATE, al soltarse el bloqueo, pisaba 'accepted' con
 * 'rejected'. Sobre PGlite las transacciones se serializan y la prueba
 * comprueba la misma regla en orden: quien llega segundo ve el estado
 * que dejó el primero.
 */
describe('COT-3 · el panel y el enlace a la vez', () => {
  const ITEM = { deliverable: 'tiktok', platformId: 'tiktok' as const, description: 'TikTok', quantity: 1, unitPrice: '1000000' };
  const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function enviadaDesdeUnNegocio() {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))[0]!;
    return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora, items: [ITEM], campaignStartsOn: '2026-11-01', campaignEndsOn: '2026-11-30',
      });
      return sendQuote(tx, c.id, TEXTOS);
    });
  }

  async function actividades(quoteId: string, kind: string): Promise<number> {
    return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM activity WHERE metadata->>'quoteId' = $1 AND metadata->>'kind' = $2",
        [quoteId, kind],
      );
      return Number(rows[0]!.n);
    });
  }

  async function etapaDe(dealId: string | null): Promise<string> {
    return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [dealId]);
      return rows[0]!.stage_id;
    });
  }

  test('la marca acepta desde el enlace mientras el creador rechaza: gana la aceptación y el panel recibe el error', async () => {
    const q = await enviadaDesdeUnNegocio();

    let soltar!: () => void;
    const retenida = new Promise<void>((r) => (soltar = r));
    let yaAcepto!: () => void;
    const acepto = new Promise<void>((r) => (yaAcepto = r));

    // La transacción del enlace acepta y NO confirma todavía: tiene la fila.
    const enlace = t.db.withPublicShare(async (tx) => {
      const r = await acceptPublicQuote(tx, q.slug, FIRMA);
      yaAcepto();
      await retenida;
      return r;
    });
    await acepto;
    // El creador pulsa «Rechazar» en ese instante.
    const panel = t.db.withWorkspace(WORKSPACE_LAURA, (tx) => rejectQuote(tx, q.id)).then(
      () => null,
      (err: unknown) => err,
    );
    await esperar(t.kind === 'postgres' ? 400 : 10);
    soltar();

    const r = await enlace;
    assert.equal(r.status, 'ok');
    const err = await panel;
    assert.ok(err instanceof QuoteTransitionError, `el panel tenía que fallar, y devolvió ${String(err)}`);
    assert.match((err as QuoteTransitionError).messageEs, /accepted/);

    const final = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, q.id));
    assert.equal(final!.status, 'accepted');
    assert.equal(final!.rejectedAt, null);
    assert.equal(await etapaDe(q.dealId), 'ganado');
  });

  test('aceptada desde el enlace, rechazar o aceptar después desde el panel lanza el error y no toca nada', async () => {
    const q = await enviadaDesdeUnNegocio();
    assert.equal((await t.db.withPublicShare((tx) => acceptPublicQuote(tx, q.slug, FIRMA))).status, 'ok');
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => rejectQuote(tx, q.id)), QuoteTransitionError);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuote(tx, q.id, TEXTOS)), QuoteTransitionError);
    const final = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, q.id));
    assert.equal(final!.status, 'accepted');
    // El «aceptar» del panel que llegó tarde no dejó su actividad.
    assert.equal(await actividades(q.id, 'quote_accepted'), 0);
  });

  test('rechazada desde el panel mientras la marca acepta: el enlace dice «rechazada» y el negocio no se gana', async () => {
    const q = await enviadaDesdeUnNegocio();
    let soltar!: () => void;
    const retenida = new Promise<void>((r) => (soltar = r));
    let yaRechazo!: () => void;
    const rechazo = new Promise<void>((r) => (yaRechazo = r));

    const panel = t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const r = await rejectQuote(tx, q.id);
      yaRechazo();
      await retenida;
      return r;
    });
    await rechazo;
    const enlace = t.db.withPublicShare((tx) => acceptPublicQuote(tx, q.slug, FIRMA));
    await esperar(t.kind === 'postgres' ? 400 : 10);
    soltar();

    assert.equal((await panel).status, 'rejected');
    assert.deepEqual(await enlace, { status: 'not_acceptable', quoteStatus: 'rejected' });
    assert.equal(await etapaDe(q.dealId), 'propuesta');
  });

  test('«Enviar» dos veces a la vez (dos pestañas): un solo envío, una sola actividad y una sola fila de historial', async () => {
    const deals = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx));
    const deal = deals.find((d) => d.stageId !== 'propuesta') ?? deals[0]!;
    const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [ITEM] }));
    const haciaPropuesta = () =>
      t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
        const { rows } = await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM deal_stage_history WHERE deal_id = $1 AND to_stage_id = 'propuesta'",
          [deal.id],
        );
        return Number(rows[0]!.n);
      });
    const antes = await haciaPropuesta();

    const [a, b] = await Promise.allSettled([
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, c.id, TEXTOS)),
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, c.id, TEXTOS)),
    ]);
    const fallos = [a, b].filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    assert.equal(fallos.length, 1, 'solo un envío pasa');
    assert.ok(fallos[0]!.reason instanceof QuoteTransitionError);

    assert.equal(await actividades(c.id, 'quote_sent'), 1);
    assert.ok((await haciaPropuesta()) - antes <= 1, 'como mucho una fila nueva hacia «Propuesta enviada»');
  });

  test('aceptar desde el enlace no suma una visita: solo la apertura cuenta', async () => {
    const q = await enviadaDesdeUnNegocio();
    assert.equal((await t.db.withPublicShare((tx) => readPublicQuote(tx, q.slug))).status, 'ok');
    assert.equal((await t.db.withPublicShare((tx) => acceptPublicQuote(tx, q.slug, FIRMA))).status, 'ok');
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, q.id));
    assert.equal(despues!.viewCount, 1);
  });
});

describe('ronda 4 · moneda del CPM, cifras del media kit y kit adjunto', () => {
  test('el CPM de referencia prefiere la moneda del workspace aunque haya uno más nuevo en otra', async () => {
    // La llave de la tabla es (nicho, país, red, desde): para tener un CPM
    // en USD MÁS NUEVO que el de COP, el de COP se corre 30 días atrás.
    await t.admin(`
      UPDATE niche_cpm_benchmark SET valid_from = valid_from - 30
       WHERE niche_slug = 'cocina' AND country = 'CO' AND platform = 'tiktok' AND currency = 'COP';
      INSERT INTO niche_cpm_benchmark (niche_slug, country, platform, currency, cpm_low, cpm_high, source, valid_from)
      VALUES ('cocina', 'CO', 'tiktok', 'USD', 11, 17, 'manual', CURRENT_DATE - 1);`);
    try {
      const inputs = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getRateCardInputs(tx, creadora)))!;
      const tiktok = inputs.benchmarks.find((b) => b.platform === 'tiktok')!;
      assert.equal(inputs.currency, 'COP');
      assert.equal(tiktok.currency, 'COP', 'un workspace en COP no recibe el CPM en dólares');
    } finally {
      await t.admin(`
        DELETE FROM niche_cpm_benchmark WHERE currency = 'USD' AND niche_slug = 'cocina' AND country = 'CO';
        UPDATE niche_cpm_benchmark SET valid_from = valid_from + 30
         WHERE niche_slug = 'cocina' AND country = 'CO' AND platform = 'tiktok' AND currency = 'COP';`);
    }
  });

  test('la cifra grande de views dice de qué red sale, y los totales salen de la base', async () => {
    const snap = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => buildMediaKitSnapshot(tx, creadora));
    const conViews = snap.redes.filter((r) => r.medianViews !== null);
    assert.ok(conViews.length > 1, 'el seed trae más de una red con mediana');
    const mejor = [...conViews].sort((a, b) => b.medianViews! - a.medianViews!)[0]!;
    assert.equal(snap.totales.medianViewsMax, mejor.medianViews);
    assert.equal(snap.totales.medianViewsMaxPlatform, mejor.platformId);
    const suma = snap.redes.reduce((acc, r) => acc + (r.followers ?? 0), 0);
    assert.equal(snap.totales.followers, suma);
  });

  test('el «N× su mediana» de cada post cuadra con la mediana que el media kit publica de su red', async () => {
    const snap = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => buildMediaKitSnapshot(tx, creadora));
    const conMultiplo = snap.topPosts.filter((p) => p.viewsVsMedian !== null);
    assert.ok(conMultiplo.length > 0, 'el seed trae posts con múltiplo');
    for (const p of conMultiplo) {
      const red = snap.redes.find((r) => r.platformId === p.platformId);
      assert.ok(red?.medianViews, `la red ${p.platformId} publica su mediana`);
      // La cuenta que haría la marca con las dos cifras de la página.
      const esperado = Math.round((p.views! / red.medianViews) * 10) / 10;
      assert.equal(Number(p.viewsVsMedian), esperado, `${p.platformId}: ${p.views} / ${red.medianViews}`);
    }
  });

  test('el media kit del seed 0004 dice lo que diría uno real: N× contra su mediana y tarifas de @mc/core (pulido r8)', async () => {
    // El seed 0004 no puede congelar su kit con buildMediaKitSnapshot
    // (la demo es relativa al reloj y el kit está fechado el 22-sep),
    // así que lo escribe a mano. Esta prueba es la que impide que lo
    // escrito a mano contradiga a la fórmula: cada tarifa se vuelve a
    // calcular con calcularItem/calcularPaquete desde sus propias
    // entradas, y cada «N×» contra la mediana que el kit publica.
    const { kit, items } = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const k = await getMediaKitById(tx, '00000004-0000-4000-8000-000000d0c001');
      const { rows } = await tx.query<{
        deliverable: string; platform_id: PlatformId | null; price_low: string; price_high: string;
        avg_views: number | null; cpm_low: string | null; cpm_high: string | null;
        adjustments: Record<string, unknown>;
      }>(
        `SELECT deliverable, platform_id, price_low::text, price_high::text, avg_views,
                cpm_low::text, cpm_high::text, adjustments
           FROM rate_card_item WHERE rate_card_id = '00000004-0000-4000-8000-0000007a1f01' ORDER BY position`);
      return { kit: k, items: rows };
    });
    assert.ok(kit, 'el seed trae su media kit');
    const snap = kit.snapshot;

    for (const p of snap.topPosts) {
      const red = snap.redes.find((r) => r.platformId === p.platformId);
      assert.ok(red?.medianViews && p.views !== null && p.viewsVsMedian !== null, `${p.platformId}: post con views y mediana`);
      const cociente = p.views / red.medianViews;
      assert.ok(Math.abs(Number(p.viewsVsMedian) - cociente) < 0.05,
        `${p.url}: dice ${p.viewsVsMedian}×, y ${p.views} / ${red.medianViews} = ${cociente.toFixed(2)}`);
      assert.equal(p.viewsVsMedian, (Math.round(cociente * 10) / 10).toFixed(1), 'con el decimal de buildMediaKitSnapshot');
    }

    assert.equal(items.length, 5);
    const precios = new Map<string, { priceLow: string; priceHigh: string }>();
    for (const it of items) {
      const adj = it.adjustments as {
        pasos: PasoCalculo[]; cantidad?: number; viewsSource?: FuenteViews; cpmSource?: string;
        componentes?: ComponentePaquete[]; descuentoPct?: string;
      };
      let calculado: { priceLow: string; priceHigh: string; pasos: PasoCalculo[] };
      if (it.platform_id === null) {
        for (const c of adj.componentes ?? []) {
          assert.deepEqual({ priceLow: c.priceLow, priceHigh: c.priceHigh }, precios.get(c.deliverable),
            `el paquete suma ${c.deliverable} al precio del tarifario`);
        }
        calculado = calcularPaquete({ componentes: adj.componentes ?? [], descuentoPct: adj.descuentoPct ?? '0', currency: 'COP' });
      } else {
        const views = adj.pasos.find((s) => s.tipo === 'views');
        const cpm = adj.pasos.find((s) => s.tipo === 'cpm');
        assert.ok(views?.tipo === 'views' && cpm?.tipo === 'cpm', `${it.deliverable}: guarda sus entradas`);
        calculado = calcularItem({
          deliverable: it.deliverable, platformId: it.platform_id, cantidad: adj.cantidad ?? 1,
          views: it.avg_views ?? 0, viewsSource: adj.viewsSource ?? views.fuente,
          ...(views.muestra === undefined ? {} : { viewsSample: views.muestra }),
          ...(views.corteHoras === undefined ? {} : { viewsCutHours: views.corteHoras }),
          cpmLow: it.cpm_low ?? '0', cpmHigh: it.cpm_high ?? '0', cpmSource: adj.cpmSource ?? cpm.fuente,
          nicheSlug: cpm.nicheSlug, country: cpm.country, currency: 'COP', modificadores: [],
        });
      }
      assert.equal(it.price_low, calculado.priceLow, `${it.deliverable}: el bajo es el de @mc/core`);
      assert.equal(it.price_high, calculado.priceHigh, `${it.deliverable}: el alto es el de @mc/core`);
      assert.deepEqual(adj.pasos, calculado.pasos, `${it.deliverable}: el «Cómo se calcula» es el de @mc/core`);
      assert.equal(redondearParaNegociar(it.price_low), it.price_low, `${it.deliverable}: tres cifras`);
      assert.equal(redondearParaNegociar(it.price_high), it.price_high, `${it.deliverable}: tres cifras`);
      precios.set(it.deliverable, { priceLow: it.price_low, priceHigh: it.price_high });
    }
    assert.deepEqual(
      snap.tarifas.map((x) => [x.priceLow, x.priceHigh]),
      items.map((i) => [i.price_low, i.price_high]),
      'el kit ofrece las tarifas del tarifario, las mismas cifras',
    );
  });

  test('en la audiencia por país, «Otros» va al final aunque pese más que el último país', async () => {
    const snap = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => buildMediaKitSnapshot(tx, creadora));
    const pais = snap.audiencia.find((a) => a.dimension === 'country');
    assert.ok(pais, 'el seed trae audiencia por país');
    const buckets = pais.buckets.map((b) => b.bucket);
    assert.ok(buckets.includes('OTHER'), 'el seed trae el segmento OTHER');
    assert.equal(buckets.at(-1), 'OTHER');
    const paises = pais.buckets.slice(0, -1).map((b) => Number(b.share));
    assert.deepEqual(paises, [...paises].sort((a, b) => b - a), 'los países, de mayor a menor');
  });

  test('el media kit adjunto viaja al enlace de la cotización; uno inventado no se acepta', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora }));
    const adjuntables = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listShareableMediaKits(tx, creadora));
    assert.equal(adjuntables[0]?.id, kit.id, 'el más reciente primero');

    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))[0]!;
    const item = { deliverable: 'tiktok', platformId: 'tiktok' as const, description: 'TikTok', quantity: 1, unitPrice: '1000000' };
    const inventado = '00000000-0000-4000-8000-0000000000aa';
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [item], mediaKitId: inventado })),
      MediaKitNotFound,
    );
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [item], mediaKitId: kit.id });
      assert.equal(c.mediaKitId, kit.id);
      // Editar el borrador sin decir nada del kit lo conserva.
      const sinTocar = await updateQuoteDraft(tx, c.id, { items: [item] });
      assert.equal(sinTocar.mediaKitId, kit.id);
      return sendQuote(tx, c.id, TEXTOS);
    });
    const publica = await t.db.withPublicShare((tx) => readPublicQuote(tx, q.slug, { count: false }));
    assert.equal(publica.status === 'ok' && publica.quote.mediaKitSlug, kit.slug);
  });

  test('solo se ofrecen los media kits que la marca puede abrir: ni despublicados ni vencidos', async () => {
    const [despublicado, vencido] = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => [
      await createMediaKit(tx, { creatorId: creadora, isPublic: false }),
      await createMediaKit(tx, { creatorId: creadora, expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    const ids = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listShareableMediaKits(tx, creadora))).map((k) => k.id);
    assert.equal(ids.includes(despublicado!.id), false);
    assert.equal(ids.includes(vencido!.id), false);
  });
});

describe('0030 con los disparadores de referencias de 0025', () => {
  test('aceptar desde el enlace sigue funcionando cuando cada clave ajena exige ver a su padre', async () => {
    // 0025 (pase de endurecimiento) crea assert_reference_visible() y un
    // disparador por clave ajena hacia una tabla con RLS. Corre con los
    // permisos de quien escribe: al aceptar, mc_public_share tiene que poder
    // LEER la etapa del negocio (GRANT y política de 0030). Desde que el
    // endurecimiento está integrado la función tiene que existir: ya no se
    // salta.
    const existe = await t.db.withCatalogs(async (tx) => {
      const { rows } = await tx.query<{ f: string | null }>("SELECT to_regproc('public.assert_reference_visible')::text AS f");
      return rows[0]!.f !== null;
    });
    assert.ok(existe, 'assert_reference_visible() no existe: falta 0025_referencias_visibles.sql');
    // En PGlite mc_app recibe sus privilegios DESPUÉS de migrar, así que el
    // bucle de 0025 no encontró tablas; se crean aquí los de estas tres.
    await t.admin(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT hija.relname AS hija, a.attname AS col, padre.relname AS padre, pa.attname AS pcol
            FROM pg_constraint k
            JOIN pg_class hija   ON hija.oid = k.conrelid
            JOIN pg_namespace n  ON n.oid = hija.relnamespace
            JOIN pg_class padre  ON padre.oid = k.confrelid
            JOIN pg_attribute a  ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
            JOIN pg_attribute pa ON pa.attrelid = padre.oid AND pa.attnum = k.confkey[1]
           WHERE n.nspname = 'public' AND k.contype = 'f' AND padre.relrowsecurity
             AND hija.relname IN ('deal', 'deal_stage_history', 'quote')
        LOOP
          EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'ref_visible_' || r.col, r.hija);
          EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW WHEN (NEW.%I IS NOT NULL) '
            'EXECUTE FUNCTION assert_reference_visible(%L, %L, %L)',
            'ref_visible_' || r.col, r.col, r.hija, r.col, r.col, r.padre, r.pcol);
        END LOOP;
      END $$;`);
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))[0]!;
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora,
        items: [{ deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok', quantity: 1, unitPrice: '1000000' }],
      });
      return sendQuote(tx, c.id, TEXTOS);
    });
    const r = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, q.slug, FIRMA));
    assert.equal(r.status, 'ok');
  });
});

describe('lo que el precio del tarifario ya incluye (derechos, exclusividad)', () => {
  const TIKTOK = {
    deliverable: 'tiktok', platformId: 'tiktok' as const, labelEs: 'TikTok dedicado',
    priceLow: '8505000.00', priceHigh: '13230000.00', avgViews: 84000,
    cpmLow: '45000.00', cpmHigh: '70000.00', overridden: false,
    adjustments: { pasos: [], modificadores: ['exclusividad_30d', 'derechos_uso_30d', 'entrega_express'] },
  };
  const REEL = { ...TIKTOK, deliverable: 'reel', platformId: 'instagram' as const, labelEs: 'Reel', adjustments: { pasos: [] } };
  const LINEA = { deliverable: 'tiktok', platformId: 'tiktok' as const, description: 'TikTok dedicado', quantity: 1, unitPrice: '8505000' };

  before(async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      saveRateCard(tx, { creatorId: creadora, currency: 'COP', basis: {}, items: [TIKTOK, REEL] }));
  });

  after(async () => {
    // El tarifario siguiente vuelve a ser uno sin condiciones.
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      saveRateCard(tx, { creatorId: creadora, currency: 'COP', basis: {}, items: [{ ...TIKTOK, adjustments: { pasos: [] } }] }));
  });

  test('cada entregable del tarifario dice qué modificadores lleva su precio', async () => {
    const vigente = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadora)))!;
    const porEntregable = Object.fromEntries(vigente.items.map((i) => [i.deliverable, i.modifierIds]));
    assert.deepEqual(porEntregable.tiktok, ['exclusividad_30d', 'derechos_uso_30d', 'entrega_express']);
    assert.deepEqual(porEntregable.reel, []);
    const terminos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => terminosIncluidosEnTarifario(tx, creadora, [LINEA]));
    assert.deepEqual(terminos, { usageRightsDays: 30, exclusivityDays: 30 });
  });

  test('el media kit dice qué incluyen sus rangos, en vez de esconderlo dentro del precio', async () => {
    const snap = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => buildMediaKitSnapshot(tx, creadora));
    assert.deepEqual(snap.tarifasIncluyen, ['exclusividad_30d', 'derechos_uso_30d', 'entrega_express']);
  });

  test('una cotización con un entregable que cobra exclusividad dice «exclusividad 30 días» en el documento', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))[0]!;
    const q = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, { dealId: deal.id, creatorId: creadora, items: [LINEA] });
      assert.equal(c.exclusivityDays, 30);
      assert.equal(c.usageRightsDays, 30);
      return sendQuote(tx, c.id, TEXTOS);
    });
    const publica = await t.db.withPublicShare((tx) => readPublicQuote(tx, q.slug, { count: false }));
    assert.equal(publica.status, 'ok');
    assert.equal(publica.status === 'ok' && publica.quote.acordado.exclusivityDays, 30);
    assert.equal(publica.status === 'ok' && publica.quote.acordado.usageRightsDays, 30);
  });

  test('lo que el creador acuerda a mano se respeta, también «no aplica»; un borrador sin decirlo lo recupera', async () => {
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx)))[0]!;
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const c = await createQuote(tx, {
        dealId: deal.id, creatorId: creadora, items: [LINEA], exclusivityDays: null, usageRightsDays: 90,
      });
      assert.equal(c.exclusivityDays, null);
      assert.equal(c.usageRightsDays, 90);
      const editada = await updateQuoteDraft(tx, c.id, { items: [LINEA] });
      assert.equal(editada.exclusivityDays, 30);
      assert.equal(editada.usageRightsDays, 30);
      // Un entregable sin condiciones no inventa ninguna.
      const reel = await updateQuoteDraft(tx, c.id, { items: [{ ...LINEA, deliverable: 'reel', platformId: 'instagram' }] });
      assert.equal(reel.exclusivityDays, null);
      assert.equal(reel.usageRightsDays, null);
      await deleteQuoteDraft(tx, c.id);
    });
  });
});

// ------------------------------------ 0031 · el negocio de la cotización

describe('0031 · el negocio sigue a su cotización: etapa, monto y ponderado', () => {
  test('enviar fija el neto en el negocio y su ponderado; aceptar desde el enlace lo vuelve a dejar en el neto', async () => {
    // Un negocio abierto a mano en 9,0 M, como el de Vitalé del hallazgo.
    const dealId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Paquete 0031', amount: '9000000' }));
    const creada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0.19',
        items: [{ deliverable: 'tiktok', platformId: 'tiktok', description: 'TikTok dedicado', quantity: 1, unitPrice: '5000000' }],
        campaignStartsOn: '2026-12-01', campaignEndsOn: '2026-12-15',
      }));
    assert.equal(creada.total, '5950000.00');

    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, creada.id, TEXTOS));
    const leer = () => t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string; amount: string; weighted: string; esperado: string }>(
        `SELECT p.stage_id, p.amount::text AS amount, p.weighted_amount::text AS weighted,
                round(p.amount * st.default_probability, 6)::text AS esperado
           FROM deal_pipeline p JOIN pipeline_stage st ON st.id = p.stage_id
          WHERE p.id = $1`, [dealId]);
      return rows[0]!;
    });
    const enviado = await leer();
    assert.equal(enviado.stage_id, 'propuesta');
    assert.equal(enviado.amount, '5000000.00', 'sin impuesto, como el resto del pipeline');
    assert.equal(Number(enviado.weighted), Number(enviado.esperado), 'el ponderado usa la probabilidad de «Propuesta enviada»');

    // La historia del negocio cuenta el cambio, con los montos en metadata.
    const actividadMonto = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ subject: string; metadata: Record<string, unknown> }>(
        "SELECT subject, metadata FROM activity WHERE deal_id = $1 AND metadata->>'kind' = 'deal_amount_from_quote'", [dealId]);
      return rows;
    });
    assert.equal(actividadMonto.length, 1);
    assert.equal(actividadMonto[0]!.subject, `[monto] ${creada.number} 9000000.00 → 5000000.00 COP`);

    // Alguien lo cambia a mano antes de que la marca acepte…
    await t.admin(`UPDATE deal SET amount = 7000000 WHERE id = '${dealId}'`);
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getSalesKpis(tx));

    // …y la marca acepta desde el enlace: la base lo deja en el neto.
    const aceptada = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, creada.slug, FIRMA));
    assert.equal(aceptada.status, 'ok');
    if (aceptada.status !== 'ok') return;
    assert.equal(aceptada.dealAmountChanged, true);
    assert.equal(aceptada.dealAmountFrom, '7000000.00');
    const ganado = await leer();
    assert.equal(ganado.stage_id, 'ganado');
    assert.equal(ganado.amount, '5000000.00');

    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getSalesKpis(tx));
    assert.equal(Number(despues.wonQuarter) - Number(antes.wonQuarter), 5_000_000, '«Ganado este trimestre» suma lo cotizado');

    // El servidor termina la aceptación y cuenta el cambio de monto.
    const terminada = await t.db.withWorkspace(aceptada.workspaceId, (tx) =>
      completePublicAcceptance(tx, creada.id, TEXTOS, { amountFrom: aceptada.dealAmountFrom ?? null, currencyFrom: aceptada.dealCurrencyFrom ?? null }));
    assert.ok(terminada.campaign?.created, 'con ventana acordada, la campaña queda planeada');
    const montos = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ subject: string }>(
        "SELECT subject FROM activity WHERE deal_id = $1 AND metadata->>'kind' = 'deal_amount_from_quote' ORDER BY occurred_at", [dealId]);
      return rows.map((r) => r.subject);
    });
    assert.deepEqual(montos, [
      `[monto] ${creada.number} 9000000.00 → 5000000.00 COP`,
      `[monto] ${creada.number} 7000000.00 → 5000000.00 COP`,
    ]);

    // La transición es la de Ventas: historial con días y sin huecos.
    const historia = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ from_stage_id: string | null; to_stage_id: string; days_in_stage: string | null }>(
        'SELECT from_stage_id, to_stage_id, days_in_stage::text AS days_in_stage FROM deal_stage_history WHERE deal_id = $1 ORDER BY id', [dealId]);
      return rows;
    });
    assert.deepEqual(historia.map((h) => [h.from_stage_id, h.to_stage_id]), [[null, 'nuevo'], ['nuevo', 'propuesta'], ['propuesta', 'ganado']]);
    assert.ok(historia.slice(1).every((h) => h.days_in_stage !== null), 'cada salida anota sus días en la etapa');

    // Con la cotización firmada y la campaña planeada, el negocio no
    // vuelve a «Contactado» desde el tablero: los tres módulos dirían
    // cosas distintas.
    await assert.rejects(
      () => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => moveDeal(tx, dealId, 'contactado')),
      (err: unknown) => err instanceof DealLocked && err.params.reason === 'campaign',
    );
    const sigue = await leer();
    assert.equal(sigue.stage_id, 'ganado');
  });

  // Hallazgo r6: Vitalé perdido «por el precio» y su COT-2026-007 todavía
  // aceptable desde el enlace; al aceptarla, el negocio volvía a «Ganado»
  // y el motivo se borraba. Perder cierra lo que está sobre la mesa.
  //
  // Con 0033 (una aceptada por negocio) enviar la segunda versión deja
  // sin efecto la primera, así que sobre la mesa hay como mucho UNA viva:
  // perder cierra esa (vista o solo enviada), no toca el borrador ni la
  // que ya quedó sin efecto, y cada enlace dice lo suyo.
  test('perder un negocio cierra sus cotizaciones abiertas: el enlace ya no lo gana ni borra el motivo', async () => {
    const ITEM = { deliverable: 'reel', platformId: 'instagram' as const, description: 'Reel', quantity: 1, unitPrice: '2000000' };
    const dealId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Para perder con cotización', amount: '2000000' }));
    const { anterior, vista, borrador } = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const a = await createQuote(tx, { dealId, creatorId: creadora, taxRate: '0', items: [ITEM] });
      const b = await createQuote(tx, { dealId, creatorId: creadora, taxRate: '0', items: [ITEM] });
      const c = await createQuote(tx, { dealId, creatorId: creadora, taxRate: '0', items: [ITEM] });
      return { anterior: await sendQuote(tx, a.id, TEXTOS), vista: await sendQuote(tx, b.id, TEXTOS), borrador: c };
    });
    // La marca abrió la segunda: queda 'viewed'.
    assert.equal((await t.db.withPublicShare((tx) => readPublicQuote(tx, vista.slug))).status, 'ok');

    const res = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      moveDeal(tx, dealId, 'perdido', { lostReason: 'precio', quoteClosedActivity: (n) => `[cerrada] ${n}` }));
    assert.equal(res.isLost, true);
    assert.deepEqual(
      res.closedQuotes.map((q) => q.number),
      [vista.number],
      'se cierra la viva, no el borrador ni la que ya quedó sin efecto',
    );

    const estado = async (id: string) => (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, id)))!;
    const final = await estado(vista.id);
    assert.equal(final.status, 'rejected');
    assert.ok(final.rejectedAt, 'con su fecha');
    assert.equal((await estado(anterior.id)).status, 'expired', 'la primera sigue sin efecto');
    assert.equal((await estado(borrador.id)).status, 'draft');

    // Deja su línea en la historia del negocio, con el motivo.
    const lineas = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ subject: string; lost_reason: string }>(
        `SELECT subject, metadata->>'lost_reason' AS lost_reason FROM activity
          WHERE deal_id = $1 AND metadata->>'kind' = 'quote_closed_on_loss' ORDER BY subject`, [dealId]);
      return rows;
    });
    assert.deepEqual(lineas, [{ subject: `[cerrada] ${vista.number}`, lost_reason: 'precio' }]);

    // La marca intenta aceptar después: la vista dice «rechazada» y la
    // anterior, «sin efecto».
    assert.deepEqual(
      await t.db.withPublicShare((tx) => acceptPublicQuote(tx, vista.slug, FIRMA)),
      { status: 'not_acceptable', quoteStatus: 'rejected' },
    );
    assert.deepEqual(
      await t.db.withPublicShare((tx) => acceptPublicQuote(tx, anterior.slug, FIRMA)),
      { status: 'not_acceptable', quoteStatus: 'superseded' },
    );
    const fila = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string; lost_reason: string | null }>(
        'SELECT stage_id, lost_reason FROM deal WHERE id = $1', [dealId]);
      return rows[0]!;
    });
    assert.deepEqual(fila, { stage_id: 'perdido', lost_reason: 'precio' }, 'sigue perdido y con su motivo');

    // Una solo enviada (la marca no la abrió) también se cierra.
    const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const id = await createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Perdido sin abrir', amount: '1000000' });
      const q = await sendQuote(tx, (await createQuote(tx, { dealId: id, creatorId: creadora, taxRate: '0', items: [ITEM] })).id, TEXTOS);
      const r = await moveDeal(tx, id, 'perdido', { lostReason: 'precio' });
      return { r, q };
    });
    assert.deepEqual(enviada.r.closedQuotes.map((q) => q.number), [enviada.q.number]);
    assert.equal((await estado(enviada.q.id)).status, 'rejected');
    assert.deepEqual(
      await t.db.withPublicShare((tx) => acceptPublicQuote(tx, enviada.q.slug, FIRMA)),
      { status: 'not_acceptable', quoteStatus: 'rejected' },
    );

    // Mover entre etapas abiertas no cierra nada.
    const otro = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const id = await createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Sigue abierto', amount: '1000000' });
      const q = await createQuote(tx, { dealId: id, creatorId: creadora, taxRate: '0', items: [ITEM] });
      await sendQuote(tx, q.id, TEXTOS);
      const r = await moveDeal(tx, id, 'negociacion');
      return { r, q };
    });
    assert.deepEqual(otro.r.closedQuotes, []);
    assert.equal((await estado(otro.q.id)).status, 'sent');
  });

  test('la marca acepta mientras el creador lo pierde: gana la aceptación y el tablero recibe DealLocked', async () => {
    const ITEM = { deliverable: 'reel', platformId: 'instagram' as const, description: 'Reel', quantity: 1, unitPrice: '2000000' };
    const { dealId, q } = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const id = await createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Carrera perder-aceptar', amount: '2000000' });
      const c = await createQuote(tx, { dealId: id, creatorId: creadora, taxRate: '0', items: [ITEM] });
      return { dealId: id, q: await sendQuote(tx, c.id, TEXTOS) };
    });
    let soltar!: () => void;
    const retenida = new Promise<void>((r) => (soltar = r));
    let yaAcepto!: () => void;
    const acepto = new Promise<void>((r) => (yaAcepto = r));
    const enlace = t.db.withPublicShare(async (tx) => {
      const r = await acceptPublicQuote(tx, q.slug, FIRMA);
      yaAcepto();
      await retenida;
      return r;
    });
    await acepto;
    const tablero = t.db.withWorkspace(WORKSPACE_LAURA, (tx) => moveDeal(tx, dealId, 'perdido', { lostReason: 'precio' })).then(
      () => null,
      (err: unknown) => err,
    );
    await new Promise((r) => setTimeout(r, t.kind === 'postgres' ? 400 : 10));
    soltar();

    assert.equal((await enlace).status, 'ok');
    const err = await tablero;
    assert.ok(err instanceof DealLocked, `el tablero tenía que recibir DealLocked, y devolvió ${String(err)}`);
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, q.id)))!.status, 'accepted');
  });

  test('enviar una cotización sobre un negocio ganado no le cambia el monto ni la etapa', async () => {
    const dealId = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const id = await createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: 'Ganado antes', amount: '4000000' });
      await moveDeal(tx, id, 'ganado');
      return id;
    });
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const q = await createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0',
        items: [{ deliverable: 'reel', platformId: 'instagram', description: 'Reel extra', quantity: 1, unitPrice: '1000000' }],
      });
      await sendQuote(tx, q.id, TEXTOS);
    });
    const fila = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ stage_id: string; amount: string }>('SELECT stage_id, amount::text AS amount FROM deal WHERE id = $1', [dealId]);
      return rows[0]!;
    });
    assert.deepEqual(fila, { stage_id: 'ganado', amount: '4000000.00' });
  });
});

// ------------------------------------------------ pulido r6 · 0033 y el aviso de bloqueo

describe('0033 · un negocio, una cotización aceptada', () => {
  const LINEA = { deliverable: 'tiktok', platformId: 'tiktok' as const, description: 'TikTok dedicado', quantity: 1, unitPrice: '5200000' };

  async function negocio(nombre: string): Promise<string> {
    return t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createDeal(tx, { companyId: COMPANY_CAFE_ALMA, name: nombre, amount: '9000000' }));
  }

  async function borrador(dealId: string, unitPrice = '5200000') {
    return t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createQuote(tx, {
        dealId, creatorId: creadora, taxRate: '0.19', items: [{ ...LINEA, unitPrice }],
        campaignStartsOn: '2026-12-01', campaignEndsOn: '2026-12-20',
      }));
  }

  const enviar = (id: string) => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sendQuote(tx, id, TEXTOS));

  /** Lo que dejaba la base antes de 0033: dos versiones vivas del mismo negocio. */
  async function dosVivas(dealId: string) {
    const vieja = await borrador(dealId, '5000000');
    const nueva = await borrador(dealId, '5200000');
    await enviar(vieja.id);
    await enviar(nueva.id);
    await t.admin(`UPDATE quote SET status = 'sent', expired_at = NULL, superseded_by = NULL WHERE id = '${vieja.id}'`);
    return { vieja: (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id)))!, nueva: (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, nueva.id)))! };
  }

  async function aceptarDesdeElEnlace(slug: string) {
    const r = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, slug, FIRMA));
    if (r.status === 'ok') await t.db.withWorkspace(r.workspaceId, (tx) => completePublicAcceptance(tx, r.quoteId, TEXTOS));
    return r;
  }

  async function contar(dealId: string) {
    return t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ campanas: string; avisos: string; aceptadas: string }>(
        `SELECT (SELECT count(*) FROM campaign c WHERE c.deal_id = $1 AND c.status <> 'cancelled') AS campanas,
                (SELECT count(*) FROM notification n JOIN quote q ON q.id = n.entity_id
                  WHERE n.kind = 'quote_accepted' AND q.deal_id = $1) AS avisos,
                (SELECT count(*) FROM quote q WHERE q.deal_id = $1 AND q.status = 'accepted') AS aceptadas`,
        [dealId],
      );
      return { campanas: Number(rows[0]!.campanas), avisos: Number(rows[0]!.avisos), aceptadas: Number(rows[0]!.aceptadas) };
    });
  }

  test('enviar una versión nueva deja la anterior sin efecto, y el detalle y el enlace lo dicen', async () => {
    const dealId = await negocio('Paquete snacks · Q4 (r6)');
    const vieja = await borrador(dealId, '5000000');
    const nueva = await borrador(dealId, '5200000');
    await enviar(vieja.id);
    await enviar(nueva.id);

    const [v, n] = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => [await getQuote(tx, vieja.id), await getQuote(tx, nueva.id)]);
    assert.equal(v!.status, 'expired');
    assert.equal(v!.supersededById, nueva.id);
    assert.equal(v!.supersededByNumber, nueva.number);
    assert.ok(v!.expiredAt, 'queda con su fecha de vencida');
    assert.deepEqual(n!.supersedes, [{ id: vieja.id, number: vieja.number }]);
    assert.equal(n!.status, 'sent');

    // La marca que abre el enlace viejo lee «sin efecto», no «venció».
    const publica = await t.db.withPublicShare((tx) => readPublicQuote(tx, v!.slug, { count: false }));
    assert.equal(publica.status, 'ok');
    if (publica.status === 'ok') {
      assert.equal(publica.quote.status, 'expired');
      assert.equal(publica.quote.superseded, true);
    }
    assert.deepEqual(await aceptarDesdeElEnlace(v!.slug), { status: 'not_acceptable', quoteStatus: 'superseded' });

    // La vigente se acepta como siempre: una campaña, un aviso.
    assert.equal((await aceptarDesdeElEnlace(n!.slug)).status, 'ok');
    assert.deepEqual(await contar(dealId), { campanas: 1, avisos: 1, aceptadas: 1 });
  });

  test('antes de enviar, el borrador y el negocio saben qué versión viva quedará sin efecto (pulido r7)', async () => {
    const dealId = await negocio('Aviso antes de enviar (r7)');
    const vieja = await borrador(dealId, '5000000');
    const nueva = await borrador(dealId, '5200000');
    await enviar(vieja.id);

    const leer = (id: string) => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, id));
    // El borrador ve la viva; la viva no se ve a sí misma.
    assert.deepEqual((await leer(nueva.id))!.liveSiblings, [{ id: vieja.id, number: vieja.number, status: 'sent' }]);
    assert.deepEqual((await leer(vieja.id))!.liveSiblings, []);
    // El formulario de nueva cotización también la ve, en el negocio.
    const deal = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listQuotableDeals(tx))).find((d) => d.id === dealId);
    assert.deepEqual(deal!.liveQuotes, [{ id: vieja.id, number: vieja.number, status: 'sent' }]);

    // Una enviada cuya validez ya pasó no se puede aceptar: no se anuncia.
    await t.admin(`UPDATE quote SET valid_until = current_date - 3 WHERE id = '${vieja.id}'`);
    assert.deepEqual((await leer(nueva.id))!.liveSiblings, []);
    await t.admin(`UPDATE quote SET valid_until = current_date + 14 WHERE id = '${vieja.id}'`);

    // Enviada la nueva, la vieja sabe cómo está su sucesora HOY.
    await enviar(nueva.id);
    assert.equal((await leer(vieja.id))!.supersededByStatus, 'sent');
    assert.deepEqual((await leer(nueva.id))!.liveSiblings, []);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuote(tx, nueva.id, TEXTOS));
    assert.equal((await leer(vieja.id))!.supersededByStatus, 'accepted');
  });

  test('dos versiones vivas del mismo negocio (datos de antes de 0033): aceptar las dos deja UNA campaña', async () => {
    const dealId = await negocio('Dos vivas (r6)');
    const { vieja, nueva } = await dosVivas(dealId);

    assert.equal((await aceptarDesdeElEnlace(nueva.slug)).status, 'ok');
    const montoGanado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ amount: string }>('SELECT amount::text AS amount FROM deal WHERE id = $1', [dealId])).rows[0]!.amount);
    // Terminar la aceptación deja sin efecto la que seguía viva.
    const sinEfecto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id));
    assert.equal(sinEfecto!.supersededById, nueva.id);

    // La segunda, desde su enlace en otra sesión: no se acepta.
    assert.deepEqual(await aceptarDesdeElEnlace(vieja.slug), { status: 'not_acceptable', quoteStatus: 'superseded' });
    assert.deepEqual(await contar(dealId), { campanas: 1, avisos: 1, aceptadas: 1 });
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const { rows } = await tx.query<{ amount: string; stage_id: string }>(
        'SELECT amount::text AS amount, stage_id FROM deal WHERE id = $1', [dealId]);
      return rows[0]!;
    });
    assert.deepEqual(despues, { amount: montoGanado, stage_id: 'ganado' }, 'el monto ganado no se pisa');
    // Y deja de estar viva: recargar el enlace no vuelve a ofrecer «Aceptar».
    const v = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id));
    assert.equal(v!.status, 'expired');
  });

  test('la base se niega aunque la otra siga viva: la segunda aceptación desde el enlace no pasa', async () => {
    const dealId = await negocio('Sin terminar (r6)');
    const { vieja, nueva } = await dosVivas(dealId);
    // Solo la parte de la base (sin completePublicAcceptance): la otra sigue viva.
    assert.equal((await t.db.withPublicShare((tx) => acceptPublicQuote(tx, nueva.slug, FIRMA))).status, 'ok');
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id)))!.status, 'sent');
    assert.deepEqual(
      await t.db.withPublicShare((tx) => acceptPublicQuote(tx, vieja.slug, FIRMA)),
      { status: 'not_acceptable', quoteStatus: 'superseded' },
    );
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id)))!.status, 'expired');
    assert.equal((await contar(dealId)).aceptadas, 1);
  });

  test('la que llega tarde al negocio ganado queda sin efecto CON la que ganó: al recargar no dice «venció»', async () => {
    const dealId = await negocio('Tarde por enlace (r7)');
    const { vieja, nueva } = await dosVivas(dealId);
    // Solo la parte de la base: el negocio queda ganado con `nueva` y
    // `vieja` sigue viva, como con datos de antes de 0033 o una carrera.
    assert.equal((await t.db.withPublicShare((tx) => acceptPublicQuote(tx, nueva.slug, FIRMA))).status, 'ok');
    assert.deepEqual(
      await t.db.withPublicShare((tx) => acceptPublicQuote(tx, vieja.slug, FIRMA)),
      { status: 'not_acceptable', quoteStatus: 'superseded' },
    );

    // El panel enlaza la versión que ganó…
    const v = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id));
    assert.equal(v!.status, 'expired');
    assert.equal(v!.supersededById, nueva.id);
    assert.equal(v!.supersededByNumber, nueva.number);

    // …y la marca que recarga el enlace lee «sin efecto», aunque su
    // «válida hasta» no haya pasado.
    const publica = await t.db.withPublicShare((tx) => readPublicQuote(tx, vieja.slug, { count: false }));
    assert.equal(publica.status, 'ok');
    if (publica.status === 'ok') {
      assert.equal(publica.quote.status, 'expired');
      assert.equal(publica.quote.superseded, true);
    }
    assert.deepEqual(await aceptarDesdeElEnlace(vieja.slug), { status: 'not_acceptable', quoteStatus: 'superseded' });
    assert.deepEqual(await contar(dealId), { campanas: 0, avisos: 0, aceptadas: 1 });
  });

  test('desde el panel, la misma guardia: DealAlreadyAccepted y nada cambia', async () => {
    const dealId = await negocio('Panel (r6)');
    const { vieja, nueva } = await dosVivas(dealId);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuoteAndCreateCampaign(tx, nueva.id, TEXTOS));
    // Aceptar desde el panel ya la dejó sin efecto; se revive para probar la guardia.
    await t.admin(`UPDATE quote SET status = 'sent', expired_at = NULL, superseded_by = NULL WHERE id = '${vieja.id}'`);

    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuoteAndCreateCampaign(tx, vieja.id, TEXTOS)),
      (err: unknown) => err instanceof DealAlreadyAccepted && err.acceptedNumber === nueva.number,
    );
    assert.deepEqual(await contar(dealId), { campanas: 1, avisos: 0, aceptadas: 1 });
  });

  test('aceptar desde el panel deja sin efecto la versión que siguiera viva', async () => {
    const dealId = await negocio('Panel con viva (r6)');
    const { vieja, nueva } = await dosVivas(dealId);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuote(tx, nueva.id, TEXTOS));
    const v = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, vieja.id));
    assert.equal(v!.status, 'expired');
    assert.equal(v!.supersededById, nueva.id);
  });

  test('dos aceptaciones a la vez desde dos enlaces: una gana y la otra queda sin efecto', async () => {
    const dealId = await negocio('A la vez (r6)');
    const { vieja, nueva } = await dosVivas(dealId);
    const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let soltar!: () => void;
    const retenida = new Promise<void>((r) => (soltar = r));
    let yaAcepto!: () => void;
    const acepto = new Promise<void>((r) => (yaAcepto = r));
    // La primera acepta y NO confirma todavía: tiene la cotización y el negocio.
    const primera = t.db.withPublicShare(async (tx) => {
      const r = await acceptPublicQuote(tx, nueva.slug, FIRMA);
      yaAcepto();
      await retenida;
      return r;
    });
    await acepto;
    const segunda = t.db.withPublicShare((tx) => acceptPublicQuote(tx, vieja.slug, { name: 'Otra persona', email: 'otra@cafealma.co' }));
    await esperar(t.kind === 'postgres' ? 400 : 10);
    soltar();

    assert.equal((await primera).status, 'ok');
    assert.deepEqual(await segunda, { status: 'not_acceptable', quoteStatus: 'superseded' });
    const estados = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => [
      (await getQuote(tx, nueva.id))!.status, (await getQuote(tx, vieja.id))!.status,
    ]);
    assert.deepEqual(estados, ['accepted', 'expired']);
  });

  test('un negocio ganado con una aceptada no recibe otra versión', async () => {
    const dealId = await negocio('Ganado (r6)');
    const primera = await borrador(dealId);
    await enviar(primera.id);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuoteAndCreateCampaign(tx, primera.id, TEXTOS));
    // Un borrador que quedó de antes de ganar.
    const tarde = await borrador(dealId, '6000000');
    await assert.rejects(enviar(tarde.id), DealAlreadyAccepted);
    const sigue = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getQuote(tx, tarde.id));
    assert.equal(sigue!.status, 'draft');
  });

  test('reabierto tras cancelar su campaña, el negocio sí acepta una versión nueva', async () => {
    const dealId = await negocio('Reabierto (r6)');
    const primera = await borrador(dealId);
    await enviar(primera.id);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => acceptQuoteAndCreateCampaign(tx, primera.id, TEXTOS));
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      await tx.query("UPDATE campaign SET status = 'cancelled' WHERE deal_id = $1", [dealId]);
      await moveDeal(tx, dealId, 'negociacion');
    });

    const otra = await borrador(dealId, '6000000');
    const enviada = await enviar(otra.id);
    assert.equal((await aceptarDesdeElEnlace(enviada.slug)).status, 'ok');
    assert.deepEqual(await contar(dealId), { campanas: 1, avisos: 1, aceptadas: 2 });
  });
});

describe('pulido r6 · el techo del media kit avisa al creador', () => {
  const AVISO = { title: '[bloqueo] título', body: '[bloqueo] cuerpo' };

  async function saltarElTecho(slug: string) {
    let ultimo: Awaited<ReturnType<typeof readPublicMediaKit>> | null = null;
    for (let o = 0; o < 6 && ultimo?.status !== 'locked'; o++) {
      for (let i = 0; i < 9 && ultimo?.status !== 'locked'; i++) {
        ultimo = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, slug, `mala-${o}-${i}`, { origin: `203.0.113.${o}` }));
      }
    }
    return ultimo!;
  }

  test('al saltar el techo, la base dice qué kit y de qué workspace, y el aviso queda uno solo', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora, password: 'la-buena' }));
    const r = await saltarElTecho(kit.slug);
    assert.equal(r.status, 'locked');
    assert.ok(r.status === 'locked' && r.linkLocked, 'la respuesta que salta el techo lo marca');
    assert.ok(r.status === 'locked' && r.mediaKitId === kit.id);
    assert.ok(r.status === 'locked' && r.workspaceId === WORKSPACE_LAURA);

    // Las respuestas siguientes (ya bloqueado) no lo repiten.
    const despues = await t.db.withPublicShare((tx) => readPublicMediaKit(tx, kit.slug, 'la-buena', { origin: '198.51.100.9' }));
    assert.equal(despues.status, 'locked');
    assert.ok(despues.status === 'locked' && !despues.linkLocked && !despues.workspaceId);

    // El servidor deja el aviso en el workspace del kit; repetirlo no apila otro.
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => notifyMediaKitLocked(tx, kit.id, AVISO)), true);
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => notifyMediaKitLocked(tx, kit.id, AVISO)), false);
    const avisos = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listMediaKitLockNotices(tx))).filter((a) => a.mediaKitId === kit.id);
    assert.equal(avisos.length, 1);
    assert.ok(avisos[0]!.lockedUntil, 'dice hasta cuándo sigue bloqueado');

    // El vecino ni lo ve ni puede dejarle un aviso a un kit que no ve.
    assert.equal(
      (await t.db.withWorkspace(WS_VECINO, (tx) => listMediaKitLockNotices(tx))).some((a) => a.mediaKitId === kit.id),
      false,
    );
    assert.equal(await t.db.withWorkspace(WS_VECINO, (tx) => notifyMediaKitLocked(tx, kit.id, AVISO)), false);

    // «Desbloquear» abre el enlace y da el aviso por atendido.
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => unlockMediaKit(tx, kit.id));
    const quedan = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listMediaKitLockNotices(tx))).filter((a) => a.mediaKitId === kit.id);
    assert.equal(quedan.length, 0);
  });

  test('«Entendido» quita el aviso sin tocar el bloqueo', async () => {
    const kit = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createMediaKit(tx, { creatorId: creadora, password: 'la-buena' }));
    await saltarElTecho(kit.slug);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => notifyMediaKitLocked(tx, kit.id, AVISO));
    const [aviso] = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listMediaKitLockNotices(tx))).filter((a) => a.mediaKitId === kit.id);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markMediaKitLockNoticeRead(tx, aviso!.id));
    const quedan = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listMediaKitLockNotices(tx))).filter((a) => a.mediaKitId === kit.id);
    assert.equal(quedan.length, 0);
    const k = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getMediaKitById(tx, kit.id));
    assert.ok(k?.lockedUntil, 'el enlace sigue bloqueado: «Entendido» no desbloquea');
  });
});
