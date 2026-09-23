import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_STATUSES, CAMPAIGN_STATUS_META, CAMPAIGN_TRANSITIONS,
  canTransitionCampaign, canEditCampaign, transitionCampaign, InvalidCampaignTransition,
  assertCampaignDates, InvalidDatesError, isIsoDate, brandBaselineFrom,
  handlesFromSocials, suggestionReasons, deliverableLabel, isDeliverable,
  brandAccountsFromSocials, defaultCampaignName, briefFromQuote, cutHoursLabel,
  BRAND_INPUT_KINDS, BRAND_INPUT_KIND_LABEL_ES, MANUAL_BRAND_INPUT_KINDS, brandInputSemantics, isBrandInputKind,
  isManualBrandInputKind, isMoneyBrandInputKind, brandCsvWindow, parseBrandCsvDay, reviewBrandCsvRows,
  calcularResultado, brandFigures, followerRateMultiple, isResultComplete, MISSING_INPUTS, type ResultInputs, type ResultPost,
  ritmoSeguidores, isBrandSnapshotDue, isBrandNoDataReason, brandNoDataReasonFor, BRAND_PLATFORMS_WITHOUT_FOLLOWER_SOURCE, BRAND_AFTER_DAYS, BRAND_BASELINE_DAYS, type BrandFollowerPoint,
} from '../src/campanas.ts';
import { addDays } from '../src/facturacion.ts';

// ------------------------------------------------------------- estados

test('cada estado tiene etiqueta en español y kind de pastilla', () => {
  for (const s of CAMPAIGN_STATUSES) {
    assert.ok(CAMPAIGN_STATUS_META[s].label.length > 0, s);
    assert.ok(['neutral', 'good', 'warn', 'bad'].includes(CAMPAIGN_STATUS_META[s].kind), s);
  }
  assert.deepEqual(
    CAMPAIGN_STATUSES.map((s) => [s, CAMPAIGN_STATUS_META[s].label, CAMPAIGN_STATUS_META[s].kind]),
    [
      ['planned', 'Planeada', 'neutral'],
      ['live', 'En curso', 'good'],
      ['measuring', 'Midiendo', 'warn'],
      ['reported', 'Reporte listo', 'good'],
      ['closed', 'Cerrada', 'neutral'],
      ['cancelled', 'Cancelada', 'bad'],
    ],
  );
});

test('transiciones válidas: la cadena y cancelar desde planned o live', () => {
  assert.equal(canTransitionCampaign('planned', 'live'), true);
  assert.equal(canTransitionCampaign('live', 'measuring'), true);
  assert.equal(canTransitionCampaign('measuring', 'reported'), true);
  assert.equal(canTransitionCampaign('reported', 'closed'), true);
  assert.equal(canTransitionCampaign('planned', 'cancelled'), true);
  assert.equal(canTransitionCampaign('live', 'cancelled'), true);
});

test('transiciones inválidas: saltos, retrocesos y salir de closed o cancelled', () => {
  assert.equal(canTransitionCampaign('planned', 'measuring'), false);
  assert.equal(canTransitionCampaign('live', 'planned'), false);
  assert.equal(canTransitionCampaign('measuring', 'cancelled'), false);
  assert.equal(canTransitionCampaign('reported', 'cancelled'), false);
  for (const to of CAMPAIGN_STATUSES) {
    assert.equal(canTransitionCampaign('closed', to), false, `closed → ${to}`);
    assert.equal(canTransitionCampaign('cancelled', to), false, `cancelled → ${to}`);
  }
  assert.deepEqual(CAMPAIGN_TRANSITIONS.closed, []);
  assert.deepEqual(CAMPAIGN_TRANSITIONS.cancelled, []);
  assert.throws(
    () => transitionCampaign({ status: 'closed', startsOn: null, brandBaselineFrom: null }, 'live'),
    (e: unknown) => e instanceof InvalidCampaignTransition && /«Cerrada» a «En curso»/.test(e.messageEs),
  );
});

test('al pasar a live se fija brand_baseline_from = starts_on − 14 si estaba vacío', () => {
  const r = transitionCampaign({ status: 'planned', startsOn: '2026-08-24', brandBaselineFrom: null }, 'live');
  assert.deepEqual(r, { status: 'live', brandBaselineFrom: '2026-08-10' });
  const keep = transitionCampaign({ status: 'planned', startsOn: '2026-08-24', brandBaselineFrom: '2026-08-01' }, 'live');
  assert.equal(keep.brandBaselineFrom, '2026-08-01', 'no pisa un valor existente');
  const sinFecha = transitionCampaign({ status: 'planned', startsOn: null, brandBaselineFrom: null }, 'live');
  assert.equal(sinFecha.brandBaselineFrom, null, 'sin starts_on no se inventa');
  const other = transitionCampaign({ status: 'live', startsOn: '2026-08-24', brandBaselineFrom: null }, 'measuring');
  assert.equal(other.brandBaselineFrom, null, 'solo al pasar a live');
});

test('brandBaselineFrom cruza meses y años sin Date local', () => {
  assert.equal(brandBaselineFrom('2026-03-05'), '2026-02-19');
  assert.equal(brandBaselineFrom('2027-01-07'), '2026-12-24');
});

test('closed y cancelled no admiten edición', () => {
  assert.equal(canEditCampaign('planned'), true);
  assert.equal(canEditCampaign('reported'), true);
  assert.equal(canEditCampaign('closed'), false);
  assert.equal(canEditCampaign('cancelled'), false);
});

// -------------------------------------------------------------- fechas

test('assertCampaignDates: ISO válido y fin ≥ inicio', () => {
  assert.doesNotThrow(() => assertCampaignDates('2026-09-02', '2026-09-09'));
  assert.doesNotThrow(() => assertCampaignDates('2026-09-02', '2026-09-02'));
  assert.doesNotThrow(() => assertCampaignDates(null, null));
  assert.doesNotThrow(() => assertCampaignDates('2026-09-02', null));
  assert.throws(() => assertCampaignDates('2026-09-09', '2026-09-02'), (e: unknown) => e instanceof InvalidDatesError && /anterior/.test(e.messageEs));
  assert.throws(() => assertCampaignDates('09/02/2026', null), InvalidDatesError);
  assert.throws(() => assertCampaignDates('2026-02-30', null), InvalidDatesError);
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
});

// --------------------------------------------------------- sugerencias

const cafeAlma = { handles: handlesFromSocials({ instagram: 'cafealma', tiktok: '@cafealma.co' }), companyName: 'Café Alma', trackingCode: 'LAURA15' };

test('handlesFromSocials toma cualquier valor de texto, sin @ y sin repetir', () => {
  assert.deepEqual(cafeAlma.handles, ['cafealma', 'cafealma.co']);
  assert.deepEqual(handlesFromSocials(null), []);
  assert.deepEqual(handlesFromSocials({ instagram: 'x', followers: 12, tiktok: ' x ', website: 'https://x.co' }), ['x'], 'sin repetir y sin la web');
});

test('motivos: mención en mentions o en la caption, código, nombre; sin motivo, vacío', () => {
  const porMencion = suggestionReasons({ caption: 'Cold brew en casa ☕ con @cafealma · código LAURA15', title: null, hashtags: ['coldbrew'], mentions: ['cafealma'] }, cafeAlma);
  assert.deepEqual(porMencion.map((r) => r.kind), ['mention', 'code']);
  assert.equal(porMencion[0]?.text, 'Menciona a @cafealma');
  assert.equal(porMencion[1]?.text, 'Incluye el código LAURA15');

  const porNombre = suggestionReasons({ caption: 'Probé el nuevo cafe alma de la esquina', title: null, hashtags: [], mentions: [] }, cafeAlma);
  assert.deepEqual(porNombre.map((r) => r.kind), ['name'], 'sin tildes ni mayúsculas');

  const conPunto = suggestionReasons({ caption: 'El cold brew #ad @cafealma.co', title: null, hashtags: [], mentions: [] }, cafeAlma);
  assert.deepEqual(conPunto.map((r) => r.text), ['Menciona a @cafealma.co'], '@cafealma.co no cuenta como @cafealma');

  const porHashtag = suggestionReasons({ caption: null, title: 'Mañanas', hashtags: ['CafeAlma'], mentions: [] }, cafeAlma);
  assert.deepEqual(porHashtag.map((r) => r.kind), ['mention']);

  const ajeno = suggestionReasons({ caption: 'Una semana de almuerzos saludables con Nutrivé', title: null, hashtags: ['mealprep'], mentions: [] }, cafeAlma);
  assert.deepEqual(ajeno, []);

  const sinCodigo = suggestionReasons({ caption: 'LAURA15 en la bio', title: null, hashtags: [], mentions: [] }, { ...cafeAlma, trackingCode: null });
  assert.deepEqual(sinCodigo, [], 'sin tracking_code no se busca código');
});

// --------------------------------------------------------- entregables

test('entregables con etiqueta; un valor desconocido se muestra tal cual', () => {
  assert.equal(isDeliverable('reel'), true);
  assert.equal(isDeliverable('podcast'), false);
  assert.equal(deliverableLabel('dedicado'), 'Video dedicado');
  assert.equal(deliverableLabel('podcast'), 'podcast');
  assert.equal(deliverableLabel(null), null);
});

// ------------------------------------------------ desde la cotización

test('brandAccountsFromSocials: solo redes del producto, sin @, llave en minúsculas, ordenadas por red', () => {
  assert.deepEqual(brandAccountsFromSocials({ TikTok: '@cafealma.co', instagram: 'cafealma', followers: 12, youtube: ' ', website: 'https://cafealma.co', linkedin: 'cafe-alma' }), [
    { platform_id: 'instagram', handle: 'cafealma' },
    { platform_id: 'tiktok', handle: 'cafealma.co' },
  ]);
  assert.deepEqual(brandAccountsFromSocials(null), []);
  assert.deepEqual(brandAccountsFromSocials('x'), []);
});

test('defaultCampaignName: empresa · primer entregable, o el número de la cotización', () => {
  assert.equal(defaultCampaignName('Café Alma', '1 reel + 1 TikTok', 'COT-2026-014'), 'Café Alma · 1 reel + 1 TikTok');
  assert.equal(defaultCampaignName('Café Alma', '  ', 'COT-2026-014'), 'Café Alma · COT-2026-014');
  assert.equal(defaultCampaignName('Café Alma', null, 'COT-2026-014'), 'Café Alma · COT-2026-014');
});

test('briefFromQuote: lo acordado en texto, en español, sin inventar lo que falta', () => {
  assert.equal(
    briefFromQuote({ agreedMetrics: ['views', 'reach'], reportCutsHours: [24, 168, 720], usageRightsDays: 90, exclusivityDays: 30, exclusivityScope: 'café', paymentTermsDays: 30 }),
    'Métricas acordadas: views, reach.\nCortes del reporte: 24 h, 7 días, 30 días.\nDerechos de uso: 90 días.\nExclusividad: 30 días (café).\nPlazo de pago: 30 días.',
  );
  assert.equal(
    briefFromQuote({ agreedMetrics: [], reportCutsHours: [], usageRightsDays: null, exclusivityDays: null, exclusivityScope: null, paymentTermsDays: 45 }),
    'Métricas acordadas: sin definir.\nSin derechos de uso.\nSin exclusividad.\nPlazo de pago: 45 días.',
  );
  assert.equal(cutHoursLabel(47), '47 h');
  assert.equal(cutHoursLabel(48), '2 días');
  assert.equal(cutHoursLabel(60), '60 h', 'dos días y medio no se redondea');
});

// ------------------------------------------- lo que aporta la marca (CAM-4)

test('brandInputSemantics: la fuente decide; el formulario es total, el CSV es diario', () => {
  assert.equal(brandInputSemantics('brand_manual'), 'total');
  assert.equal(brandInputSemantics('brand_csv'), 'daily');
  assert.deepEqual([...MANUAL_BRAND_INPUT_KINDS], ['code_redemptions', 'orders', 'revenue', 'signups']);
  assert.equal(isBrandInputKind('csv_sales'), true);
  assert.equal(isBrandInputKind('postback'), false, 'postback es de fase 2: el producto no lo escribe');
  assert.equal(isManualBrandInputKind('csv_sales'), false);
  assert.equal(isMoneyBrandInputKind('revenue'), true);
  assert.equal(isMoneyBrandInputKind('orders'), false);
  for (const k of BRAND_INPUT_KINDS) assert.ok(BRAND_INPUT_KIND_LABEL_ES[k].length > 0, k);
});

test('brandCsvWindow: starts_on − 7 … ends_on + 60; sin fechas no hay ventana', () => {
  assert.deepEqual(brandCsvWindow('2026-09-02', '2026-09-09'), { from: '2026-08-26', to: '2026-11-08' });
  assert.equal(brandCsvWindow(null, '2026-09-09'), null);
  assert.equal(brandCsvWindow('2026-09-02', null), null);
  assert.throws(() => brandCsvWindow('2026-09-09', '2026-09-02'), InvalidDatesError);
});

test('parseBrandCsvDay: ISO o día/mes/año; nunca adivina mes/día', () => {
  assert.equal(parseBrandCsvDay('2026-09-02'), '2026-09-02');
  assert.equal(parseBrandCsvDay(' 02/09/2026 '), '2026-09-02');
  assert.equal(parseBrandCsvDay('2-9-2026'), '2026-09-02');
  assert.equal(parseBrandCsvDay('02.09.2026'), '2026-09-02');
  assert.equal(parseBrandCsvDay('09/14/2026'), null, 'mes/día no se lee: el 14 no es un mes');
  assert.equal(parseBrandCsvDay('31/02/2026'), null);
  assert.equal(parseBrandCsvDay('2026-02-30'), null);
  assert.equal(parseBrandCsvDay('el martes'), null);
  assert.equal(parseBrandCsvDay(''), null);
});

const numero = (c: string) => {
  const n = Number(c.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && c.trim() !== '' ? n : null;
};

test('reviewBrandCsvRows: acepta lo que cabe en la ventana y rechaza con motivo lo demás', () => {
  const window = { from: '2026-08-26', to: '2026-11-08' };
  const r = reviewBrandCsvRows(
    [
      { line: 2, day: '2026-09-02', sales: '1.250.000,50', orders: '12', redemptions: '3' },
      { line: 3, day: '03/09/2026', sales: '980000', orders: '', redemptions: undefined },
      { line: 4, day: '2026-08-01', sales: '10' },
      { line: 5, day: 'ayer', sales: '10' },
      { line: 6, day: '2026-09-02', sales: '999' },
      { line: 7, day: '2026-09-04', sales: '' },
      { line: 8, day: '2026-09-05', sales: 'x' },
      { line: 9, day: '2026-09-06', sales: '-5' },
      { line: 10, day: '2026-09-07', sales: '5', orders: '1,5' },
      { line: 11, day: '2026-09-08', sales: '5', redemptions: '-1' },
      { line: 12, day: '2026-11-08', sales: '0' },
    ],
    window,
    numero,
  );
  assert.deepEqual(r.accepted, [
    { line: 2, day: '2026-09-02', sales: '1250000.50', orders: 12, redemptions: 3 },
    { line: 3, day: '2026-09-03', sales: '980000.00', orders: null, redemptions: null },
    { line: 12, day: '2026-11-08', sales: '0.00', orders: null, redemptions: null },
  ]);
  assert.deepEqual(
    r.rejected.map((x) => [x.line, x.reason, x.value]),
    [
      [4, 'fuera_de_rango', '2026-08-01'],
      [5, 'fecha_ilegible', 'ayer'],
      [6, 'dia_repetido', '2026-09-02'],
      [7, 'ventas_vacia', ''],
      [8, 'ventas_ilegible', 'x'],
      [9, 'ventas_negativa', '-5'],
      [10, 'pedidos_ilegible', '1,5'],
      [11, 'canjes_ilegible', '-1'],
    ],
  );
});

// ---------------------------------------------- seguidores de la marca (CAM-3)

/**
 * La serie de @cafealma del seed 0003 §2, generada con su misma fórmula:
 * día 0 = 4 jul 2026 con 18 200; antes (d < 37) 12 + (2d mod 3); ventana
 * 10–17 ago (d 37..44) 150,155,175,160,150,150,150,150; después 22 + (5d mod 9).
 */
function serieDelSeed(): BrandFollowerPoint[] {
  const gains = [150, 155, 175, 160, 150, 150, 150, 150];
  let total = 18200;
  const out: BrandFollowerPoint[] = [];
  for (let d = 0; d < 60; d++) {
    const gain = d === 0 ? 0 : d >= 37 && d <= 44 ? gains[d - 37]! : d > 44 ? 22 + (d * 5) % 9 : 12 + (d * 2) % 3;
    total += gain;
    out.push({ day: addDays('2026-07-04', d), followers: total });
  }
  return out;
}
const CAFE_ALMA = { baselineFrom: '2026-07-27', startsOn: '2026-08-10', endsOn: '2026-08-17' };

test('ritmoSeguidores con el seed de Café Alma: 12,9286/día antes, 155/día en campaña, 1 240 ganados, ×12', () => {
  const r = ritmoSeguidores(serieDelSeed(), CAFE_ALMA);
  assert.equal(r.baselineRate, 181 / 14);
  assert.equal(Number(r.baselineRate!.toFixed(4)), 12.9286);
  assert.equal(r.campaignRate, 155);
  assert.equal(r.gained, 1240);
  assert.equal(Math.round(r.ratio!), 12);
  assert.equal(r.diasDeLineaBase, 14);
  assert.equal(r.baselineDataFrom, '2026-07-27');
  assert.equal(r.fiable, true);
});

test('la serie desordenada y con días sin cifra da lo mismo: los null se ignoran', () => {
  const serie = serieDelSeed().reverse();
  serie.push({ day: '2026-08-12', followers: null }); // el mismo día, sin cifra (una marca «no encontrada» ese día)
  const r = ritmoSeguidores(serie, CAFE_ALMA);
  assert.equal(r.campaignRate, 155);
  assert.equal(r.gained, 1240);
});

test('sin lectura anterior a la línea base, el ancla es la primera lectura: 13 intervalos pero 14 días con datos', () => {
  // Lo que deja el job cuando la campaña se crea justo 14 días antes: lecturas desde brand_baseline_from.
  const serie = serieDelSeed().filter((p) => p.day >= CAFE_ALMA.baselineFrom);
  const r = ritmoSeguidores(serie, CAFE_ALMA);
  assert.equal(r.diasDeLineaBase, 14);
  assert.equal(r.fiable, true);
  assert.equal(r.baselineRate, 168 / 13);
  assert.equal(r.campaignRate, 155, 'la campaña ancla en la lectura del 9 de agosto');
  assert.equal(r.gained, 1240);
});

test('línea base corta: se marca, no se inventa', () => {
  // La campaña se creó el 6 de agosto: cuatro días de línea base (6, 7, 8 y 9).
  const serie = serieDelSeed().filter((p) => p.day >= '2026-08-06');
  const r = ritmoSeguidores(serie, CAFE_ALMA);
  assert.equal(r.diasDeLineaBase, 4);
  assert.equal(r.baselineDataFrom, '2026-08-06');
  assert.equal(r.fiable, false);
  assert.ok(r.baselineRate !== null && r.campaignRate === 155);
  assert.ok(r.ratio !== null);
});

test('huecos de días: un promedio entre lecturas reales no cambia con un día perdido', () => {
  const serie = serieDelSeed().filter((p) => p.day !== '2026-08-01' && p.day !== '2026-08-13');
  const r = ritmoSeguidores(serie, CAFE_ALMA);
  assert.equal(r.baselineRate, 181 / 14);
  assert.equal(r.campaignRate, 155);
  assert.equal(r.gained, 1240);
  assert.equal(r.diasDeLineaBase, 14);
});

test('una sola lectura, sin anterior: no hay intervalo, no hay tasa', () => {
  const r = ritmoSeguidores([{ day: '2026-08-12', followers: 19000 }], CAFE_ALMA);
  assert.equal(r.baselineRate, null);
  assert.equal(r.campaignRate, null);
  assert.equal(r.gained, null);
  assert.equal(r.ratio, null);
  assert.equal(r.diasDeLineaBase, 0);
  assert.equal(r.fiable, false);
});

test('serie vacía, solo nulos o campaña sin fechas → todo null y nada de ceros', () => {
  for (const r of [
    ritmoSeguidores([], CAFE_ALMA),
    ritmoSeguidores([{ day: '2026-08-10', followers: null }], CAFE_ALMA),
    ritmoSeguidores(serieDelSeed(), { baselineFrom: null, startsOn: null, endsOn: null }),
  ]) {
    assert.deepEqual(r, { baselineRate: null, campaignRate: null, gained: null, ratio: null, diasDeLineaBase: 0, baselineDataFrom: null, fiable: false });
  }
});

test('campaña en curso (sin ends_on o antes de terminar): la tasa va hasta la última lectura', () => {
  const hastaHoy = serieDelSeed().filter((p) => p.day <= '2026-08-13');
  const r = ritmoSeguidores(hastaHoy, { ...CAFE_ALMA, endsOn: null });
  assert.equal(r.gained, 150 + 155 + 175 + 160);
  assert.equal(r.campaignRate, 640 / 4);
  assert.equal(r.fiable, true);
});

test('sin brand_baseline_from no hay línea base pero sí campaña; una línea base que no crece no da ratio', () => {
  const r = ritmoSeguidores(serieDelSeed(), { ...CAFE_ALMA, baselineFrom: null });
  assert.equal(r.baselineRate, null);
  assert.equal(r.campaignRate, 155);
  assert.equal(r.ratio, null);
  assert.equal(r.fiable, false);
  const plana = serieDelSeed().map((p) => (p.day < CAFE_ALMA.startsOn ? { ...p, followers: 18200 } : p));
  const r2 = ritmoSeguidores(plana, CAFE_ALMA);
  assert.equal(r2.baselineRate, 0);
  assert.equal(r2.ratio, null, 'dividir entre cero no es «×∞»');
});

test('isBrandSnapshotDue: estado, cuentas y ventana [baseline, ends_on + 30]', () => {
  const base = { status: 'live' as const, startsOn: '2026-08-10', endsOn: '2026-08-17', brandBaselineFrom: '2026-07-27', brandAccounts: 1 };
  assert.equal(isBrandSnapshotDue(base, '2026-07-27'), true);
  assert.equal(isBrandSnapshotDue(base, '2026-07-26'), false, 'antes de la línea base');
  assert.equal(isBrandSnapshotDue(base, addDays('2026-08-17', BRAND_AFTER_DAYS)), true);
  assert.equal(isBrandSnapshotDue(base, addDays('2026-08-17', BRAND_AFTER_DAYS + 1)), false, 'después de ends_on + 30');
  assert.equal(isBrandSnapshotDue({ ...base, brandAccounts: 0 }, '2026-08-12'), false, 'sin cuentas de la marca');
  for (const status of ['reported', 'closed', 'cancelled'] as const) assert.equal(isBrandSnapshotDue({ ...base, status }, '2026-08-12'), false, status);
  for (const status of ['planned', 'measuring'] as const) assert.equal(isBrandSnapshotDue({ ...base, status }, '2026-08-12'), true, status);
  // Sin brand_baseline_from: starts_on − 14. Sin fechas: siempre (se mide desde que existe).
  assert.equal(isBrandSnapshotDue({ ...base, brandBaselineFrom: null }, addDays('2026-08-10', -BRAND_BASELINE_DAYS)), true);
  assert.equal(isBrandSnapshotDue({ ...base, brandBaselineFrom: null }, addDays('2026-08-10', -BRAND_BASELINE_DAYS - 1)), false);
  assert.equal(isBrandSnapshotDue({ ...base, startsOn: null, endsOn: null, brandBaselineFrom: null }, '2030-01-01'), true);
});

test('las razones «sin cifra» son un vocabulario cerrado', () => {
  assert.equal(isBrandNoDataReason('not_found'), true);
  assert.equal(isBrandNoDataReason('no_public_source'), true);
  assert.equal(isBrandNoDataReason('instagram.business_discovery'), false);
});

test('brandNoDataReasonFor: lo definitivo deja razón; lo que se reintenta, no', () => {
  assert.equal(brandNoDataReasonFor('not_found'), 'not_found');
  assert.equal(brandNoDataReasonFor('invalid_handle'), 'not_found');
  assert.equal(brandNoDataReasonFor('not_discoverable'), 'not_discoverable');
  assert.equal(brandNoDataReasonFor('not_configured'), null);
  assert.equal(brandNoDataReasonFor('transient'), null);
  assert.deepEqual(BRAND_PLATFORMS_WITHOUT_FOLLOWER_SOURCE, ['tiktok']);
});

// ---------------------------------------------------- resultado (CAM-5)

/** Un post con sus lecturas por corte; las cifras por defecto son las de la lectura manual a 720 h del seed 0003. */
function post(id: string, platformId: string, maxAgeHours: number, cuts: Partial<Record<24 | 72 | 168 | 720, Partial<ResultPost['cuts'][number]>>>): ResultPost {
  return {
    postId: id,
    platformId,
    maxAgeHours,
    cuts: Object.entries(cuts).map(([c, m]) => ({
      cutHours: Number(c) as 24 | 72 | 168 | 720,
      views: null, reach: null, interactions: null, saves: null, shares: null, linkClicks: null, reachNonFollowers: null,
      ...m,
    })),
  };
}

/** Las líneas base a 720 h y 168 h del seed 0002 (fiables). */
const BASELINES: ResultInputs['baselines'] = [
  { platformId: 'instagram', cutHours: 720, medianViews: 69000, sampleSize: 9, reliable: true },
  { platformId: 'tiktok', cutHours: 720, medianViews: 121500, sampleSize: 10, reliable: true },
  { platformId: 'youtube', cutHours: 720, medianViews: 47000, sampleSize: 8, reliable: true },
  { platformId: 'tiktok', cutHours: 168, medianViews: 115446, sampleSize: 17, reliable: true },
];

/** Café Alma en el seed: las dos lecturas manuales a 720 h, la serie de @cafealma y los aportes de la marca. */
function resultadoCafeAlma(): ResultInputs {
  return {
    amount: '3100000.00',
    currency: 'COP',
    startsOn: '2026-08-10',
    endsOn: '2026-08-17',
    brandBaselineFrom: '2026-07-27',
    posts: [
      post('d01', 'instagram', 1032, { 720: { views: 412000, reach: 296000, interactions: 34710, saves: 6200, shares: 3100, linkClicks: 3900, reachNonFollowers: 172000 } }),
      post('d02', 'tiktok', 984, { 720: { views: 300000, reach: 190000, interactions: 22820, saves: 3400, shares: 2000, linkClicks: 2340, reachNonFollowers: 110000 } }),
    ],
    baselines: BASELINES,
    brandSeries: [{ platformId: 'instagram', points: serieDelSeed() }],
    brandTotals: [
      { kind: 'code_redemptions', source: 'brand_manual', value: '318.00', currency: null },
      { kind: 'revenue', source: 'brand_manual', value: '8400000.00', currency: 'COP' },
    ],
  };
}

test('calcularResultado: Café Alma reproduce el seed recalculado (CPM 4 353,93, no los 11 800 del mock)', () => {
  const r = calcularResultado(resultadoCafeAlma());
  assert.deepEqual(
    { ...r },
    {
      cutHours: 720,
      partial: false,
      views: 712000,
      reach: 486000,
      interactions: 57530,
      saves: 9600,
      shares: 5100,
      linkClicks: 6240,
      reachNonFollowersPct: '0.58025',
      viewsVsMedian: '4.496',
      brandFollowersGained: 1240,
      brandFollowersBaselineRate: '12.9286',
      brandFollowersCampaignRate: '155.0000',
      codeRedemptions: 318,
      attributedRevenue: '8400000.00',
      currency: 'COP',
      cpm: '4353.93',
      costPerFollower: '2500.00',
      cpa: '9748.43',
      emv: null,
      missingInputs: ['brand_csv_sales'],
      redemptionsSource: 'manual',
      revenueSource: 'manual',
    },
  );
  assert.equal(followerRateMultiple(r.brandFollowersBaselineRate, r.brandFollowersCampaignRate)?.toFixed(2), '11.99', '«×12 el ritmo»');
  assert.equal(isResultComplete(r), false, 'falta el CSV de ventas');
});

test('calcularResultado: Nutrivé sin datos de la marca da null, nunca cero, y lo dice', () => {
  const r = calcularResultado({
    amount: '4700000.00', currency: 'COP', startsOn: '2026-07-15', endsOn: '2026-07-22', brandBaselineFrom: '2026-07-01',
    posts: [post('d05', 'youtube', 1656, { 720: { views: 58000, reach: 41000, interactions: 4250, saves: 900, shares: 310, linkClicks: 420, reachNonFollowers: 22000 } })],
    baselines: BASELINES, brandSeries: [], brandTotals: [],
  });
  assert.deepEqual(r.missingInputs, ['brand_followers', 'brand_inputs']);
  assert.equal(r.views, 58000);
  assert.equal(r.viewsVsMedian, '1.234');
  assert.equal(r.cpm, '81034.48');
  for (const k of ['brandFollowersGained', 'brandFollowersBaselineRate', 'brandFollowersCampaignRate', 'codeRedemptions', 'attributedRevenue', 'costPerFollower', 'cpa'] as const) {
    assert.equal(r[k], null, k);
  }
});

test('calcularResultado: el corte es el mayor que todos alcanzaron; a 7 días es parcial', () => {
  const r = calcularResultado({
    ...resultadoCafeAlma(),
    posts: [
      post('d03', 'tiktok', 480, { 168: { views: 129299, reach: 84044 }, 720: { views: 137074 } }),
      post('d04', 'tiktok', 384, { 168: { views: 120000, reach: 80000 } }),
    ],
  });
  assert.equal(r.cutHours, 168);
  assert.equal(r.partial, true);
  assert.equal(r.views, 249299, 'las dos a 7 días, no una a 30 y otra a 7');
  assert.equal(r.viewsVsMedian, (((129299 ** 2) / 115446 + (120000 ** 2) / 115446) / 249299).toFixed(3));
  assert.equal(r.saves, null, 'un dato que no trae ningún post es null, no 0');
  assert.equal(isResultComplete(r), false);
});

test('calcularResultado: sin posts o sin ningún corte común, las cifras son null y falta «posts»', () => {
  const sin = calcularResultado({ ...resultadoCafeAlma(), posts: [] });
  assert.equal(sin.views, null);
  assert.equal(sin.cpm, null);
  assert.equal(sin.cutHours, 720);
  assert.deepEqual(sin.missingInputs, ['posts', 'brand_csv_sales']);
  const joven = calcularResultado({ ...resultadoCafeAlma(), posts: [post('nuevo', 'tiktok', 3, {})] });
  assert.deepEqual(joven.missingInputs.slice(0, 1), ['posts']);
  assert.equal(joven.cpa, '9748.43', 'el CPA no depende de los posts');
});

test('calcularResultado: ninguna división por cero, y sin monto no hay CPM ni CPA', () => {
  const cero = calcularResultado({
    ...resultadoCafeAlma(),
    posts: [post('x', 'instagram', 800, { 720: { views: 0, reach: 0, reachNonFollowers: 0 } })],
    brandSeries: [],
    brandTotals: [{ kind: 'code_redemptions', source: 'brand_manual', value: '0.00', currency: null }],
  });
  assert.equal(cero.views, 0, 'cero views medidas es un cero de verdad');
  assert.equal(cero.cpm, null);
  assert.equal(cero.cpa, null);
  assert.equal(cero.reachNonFollowersPct, null);
  assert.equal(cero.viewsVsMedian, null);
  const sinMonto = calcularResultado({ ...resultadoCafeAlma(), amount: null });
  assert.equal(sinMonto.cpm, null);
  assert.equal(sinMonto.cpa, null);
  assert.equal(sinMonto.costPerFollower, null);
  assert.deepEqual(sinMonto.missingInputs, ['amount', 'brand_csv_sales']);
});

test('calcularResultado: el CSV manda sobre el total manual; ingresos en otra moneda no se atribuyen', () => {
  const conCsv = calcularResultado({
    ...resultadoCafeAlma(),
    brandTotals: [
      ...resultadoCafeAlma().brandTotals,
      { kind: 'csv_sales', source: 'brand_csv', value: '2880000.50', currency: 'COP' },
      { kind: 'code_redemptions', source: 'brand_csv', value: '5.00', currency: null },
    ],
  });
  assert.deepEqual([conCsv.codeRedemptions, conCsv.attributedRevenue, conCsv.redemptionsSource, conCsv.revenueSource], [5, '2880000.50', 'csv', 'csv']);
  assert.deepEqual(conCsv.missingInputs, [], 'con el CSV no falta nada');
  assert.equal(conCsv.cpa, '620000.00');
  assert.equal(isResultComplete(conCsv), true);
  const usd = calcularResultado({ ...resultadoCafeAlma(), brandTotals: [{ kind: 'revenue', source: 'brand_manual', value: '400.00', currency: 'USD' }] });
  assert.equal(usd.attributedRevenue, null);
  assert.equal(usd.codeRedemptions, null);
});

test('calcularResultado: sin línea base fiable en una red, vs mediana es null y falta «baseline»', () => {
  const r = calcularResultado({ ...resultadoCafeAlma(), baselines: BASELINES.map((b) => (b.platformId === 'tiktok' ? { ...b, reliable: false } : b)) });
  assert.equal(r.viewsVsMedian, null);
  assert.deepEqual(r.missingInputs, ['baseline', 'brand_csv_sales']);
  assert.equal(r.views, 712000, 'lo demás no cambia');
});

test('calcularResultado: línea base de la marca corta → «brand_followers_baseline_short»', () => {
  const r = calcularResultado({ ...resultadoCafeAlma(), brandSeries: [{ platformId: 'instagram', points: serieDelSeed().filter((p) => p.day >= '2026-08-05') }] });
  assert.ok(r.brandFollowersGained !== null);
  assert.ok(r.missingInputs.includes('brand_followers_baseline_short'));
  assert.deepEqual([...MISSING_INPUTS], ['posts', 'amount', 'baseline', 'brand_followers', 'brand_followers_baseline_short', 'brand_inputs', 'brand_csv_sales']);
});

test('calcularResultado: una razón que no cabe en numeric(8,3) se recorta en vez de tumbar el UPSERT', () => {
  const r = calcularResultado({
    ...resultadoCafeAlma(),
    posts: [post('viral', 'instagram', 800, { 720: { views: 2_000_000_000 } })],
    baselines: [{ platformId: 'instagram', cutHours: 720, medianViews: 15, sampleSize: 20, reliable: true }],
  });
  assert.equal(r.viewsVsMedian, '99999.999');
});

test('calcularResultado: los dos ritmos se suman sobre las mismas redes', () => {
  // Instagram con línea base (la del seed) y una segunda red que empieza a medirse con la campaña.
  const sinLineaBase = serieDelSeed().filter((p) => p.day >= '2026-08-10').map((p) => ({ ...p, followers: p.followers === null ? null : p.followers * 2 }));
  const r = calcularResultado({
    ...resultadoCafeAlma(),
    brandSeries: [{ platformId: 'instagram', points: serieDelSeed() }, { platformId: 'tiktok', points: sinLineaBase }],
  });
  assert.equal(r.brandFollowersBaselineRate, '12.9286');
  assert.equal(r.brandFollowersCampaignRate, '155.0000', 'la red sin línea base no infla el ritmo en campaña');
  assert.ok((r.brandFollowersGained ?? 0) > 1240, 'sus seguidores ganados sí cuentan');
  assert.ok(r.missingInputs.includes('brand_followers_baseline_short'));
});

test('brandFigures: cada concepto elige su fuente; ingresos en otra moneda se nombran, no se atribuyen', () => {
  const f = brandFigures(
    [
      { kind: 'code_redemptions', source: 'brand_manual', value: '318.00', currency: null },
      { kind: 'csv_sales', source: 'brand_csv', value: '100.00', currency: 'COP' },
      { kind: 'revenue', source: 'brand_manual', value: '9.00', currency: 'COP' },
    ],
    'COP',
  );
  assert.deepEqual(f.redemptions, { value: '318.00', source: 'manual', overrode: false }, 'el CSV no trae canjes: manda el manual');
  assert.deepEqual(f.revenue, { value: '100.00', source: 'csv', overrode: true });
  assert.equal(f.revenueSkippedCurrency, null);
  const usd = brandFigures([{ kind: 'revenue', source: 'brand_manual', value: '400.00', currency: 'USD' }], 'COP');
  assert.deepEqual([usd.revenue, usd.revenueSkippedCurrency], [null, 'USD']);
});
