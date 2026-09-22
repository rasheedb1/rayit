import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_STATUSES, CAMPAIGN_STATUS_META, CAMPAIGN_TRANSITIONS,
  canTransitionCampaign, canEditCampaign, transitionCampaign, InvalidCampaignTransition,
  assertCampaignDates, InvalidDatesError, isIsoDate, brandBaselineFrom,
  handlesFromSocials, suggestionReasons, deliverableLabel, isDeliverable,
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
  assert.deepEqual(handlesFromSocials({ instagram: 'x', followers: 12, tiktok: ' x ' }), ['x']);
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
