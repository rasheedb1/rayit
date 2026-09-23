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
} from '../src/campanas.ts';

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
