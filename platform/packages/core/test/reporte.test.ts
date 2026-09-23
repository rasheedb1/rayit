/**
 * El payload del reporte a la marca (CAM-6), armado con las entradas de
 * Café Alma tal como las trae el seed 0003: lo acordado, dos posts con
 * sus dos cortes, el resultado, la curva de @cafealma y los aportes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canGenerateReport, construirReporte, isReportPayloadV1, isReportSentViaMvp, reportCutsHours, reportForbiddenMatch,
  trackingUrlSinParametros, tituloParaLaMarca, DATO_OMITIDO, ReportPayloadRejectedError, ReportAlreadySentError, ReportNotAvailableError, ReportNotSendableError,
  REPORT_PAYLOAD_VERSION, REPORT_STATUS_META, REPORT_SENT_VIA_LABEL_ES, REPORTABLE_CAMPAIGN_STATUSES,
  type ReportInputs, type ReportPostCut,
} from '../src/reporte.ts';
import { CAMPAIGN_STATUSES } from '../src/campanas.ts';

const corte = (cutHours: number, views: number): ReportPostCut => ({
  cutHours, ageHours: cutHours, views, reach: Math.round(views * 0.7), likes: Math.round(views * 0.06),
  comments: 200, shares: 900, saves: 1500, totalInteractions: Math.round(views * 0.06) + 2600,
});

/** Las entradas de Café Alma, con lo que la consulta trae DE MÁS a propósito (caption, notas) para ver que no pasa. */
function entradasCafeAlma(): ReportInputs {
  return {
    generatedAt: '2026-09-23T12:00:00Z',
    workspace: { locale: 'es-CO', timezone: 'America/Bogota', currency: 'COP' },
    campaign: {
      name: 'Lanzamiento cold brew',
      startsOn: '2026-08-10',
      endsOn: '2026-08-17',
      amount: '3100000.00',
      currency: 'COP',
      trackingCode: 'LAURA15',
      trackingUrl: 'https://cafealma.co/cold-brew?utm_source=instagram&utm_medium=creator&utm_campaign=laura_coldbrew',
      brandBaselineFrom: '2026-07-27',
    },
    company: { name: 'Café Alma' },
    creator: { displayName: 'Laura Ríos', handle: '@laura.cocinafacil' },
    agreed: {
      quoteNumber: 'COT-2026-014',
      metrics: ['views', 'reach', 'code_redemptions'],
      cutsHours: [720, 168, 168, 999],
      usageRightsDays: 90,
      exclusivityDays: null,
      exclusivityScope: null,
      paymentTermsDays: 30,
      campaignStartsOn: '2026-08-10',
      campaignEndsOn: '2026-08-17',
    },
    posts: [
      {
        platformId: 'instagram', deliverable: 'reel', title: null,
        caption: 'Cold brew en casa en 3 pasos ☕ Con @cafealma · código LAURA15',
        url: 'https://www.instagram.com/reel/demo-d01/', publishedAt: '2026-08-10T17:00:00Z', isPrimary: true,
        cuts: [corte(24, 90000), corte(720, 412000), corte(168, 300000)],
        latest: { ...corte(720, 412000), capturedAt: '2026-09-10T06:00:00Z' },
      },
      {
        platformId: 'tiktok', deliverable: 'tiktok', title: null,
        caption: 'El cold brew que me salva las mañanas 🧊 #ad @cafealma.co',
        url: 'https://www.tiktok.com/@laura.cocinafacil/video/demo-d02', publishedAt: '2026-08-12T16:30:00Z', isPrimary: false,
        cuts: [corte(168, 210000)],
        latest: null,
      },
    ],
    result: {
      computedAt: '2026-09-12T07:30:00Z', cutHours: 720, views: 712000, reach: 486000, interactions: 57630, saves: 9600,
      shares: 5100, linkClicks: 6240, reachNonFollowersPct: '0.58000', viewsVsMedian: null, brandFollowersGained: 1240,
      brandFollowersBaselineRate: '12.9286', brandFollowersCampaignRate: '155.0000', codeRedemptions: 318,
      attributedRevenue: '8400000.00', currency: 'COP', cpm: '11800.00', costPerFollower: '2500.00', cpa: '26400.00',
      emv: null, missingInputs: ['brand_csv_sales'],
    },
    brandFollowers: {
      platformId: 'instagram', handle: 'cafealma',
      points: [
        { day: '2026-08-11', followers: 18700 },
        { day: '2026-08-10', followers: 18550 },
        { day: '2026-08-10', followers: 18560 },
        { day: 'no-es-fecha', followers: 1 },
        { day: '2026-07-27', followers: 18400 },
      ],
    },
    brandInputs: [
      { kind: 'code_redemptions', day: '2026-09-11', value: '318', currency: null, source: 'brand_manual', receivedAt: '2026-09-11T14:00:00Z' },
      { kind: 'revenue', day: '2026-09-11', value: '8400000.00', currency: 'COP', source: 'brand_manual', receivedAt: '2026-09-11T14:00:00Z' },
    ],
  };
}

// ------------------------------------------------------------ el payload

test('construirReporte: versión 1 con lo acordado, dos posts con sus cortes, resultado, curva y aportes', () => {
  const p = construirReporte(entradasCafeAlma());
  assert.equal(p.version, REPORT_PAYLOAD_VERSION);
  assert.ok(isReportPayloadV1(p));
  assert.equal(p.generatedAt, '2026-09-23T12:00:00Z');
  assert.deepEqual([p.locale, p.timezone, p.currency], ['es-CO', 'America/Bogota', 'COP']);
  assert.equal(p.company.name, 'Café Alma');
  assert.deepEqual(p.creator, { displayName: 'Laura Ríos', handle: '@laura.cocinafacil' });
  assert.equal(p.agreed?.quoteNumber, 'COT-2026-014');
  assert.deepEqual(p.agreed?.metrics, ['views', 'reach', 'code_redemptions']);
  // Los cortes acordados, sin repetidos, ordenados y solo los que la vista sabe calcular.
  assert.deepEqual(p.cutsHours, [168, 720]);
  assert.equal(p.posts.length, 2);
  const [reel, tiktok] = p.posts;
  assert.equal(reel!.title, 'Cold brew en casa en 3 pasos ☕ Con @cafealma · código LAURA15');
  assert.deepEqual(reel!.cuts.map((c) => c?.views ?? null), [300000, 412000]);
  assert.equal(reel!.latest?.capturedAt, '2026-09-10T06:00:00Z');
  // El corte a 30 días del TikTok no ha llegado: null, nunca cero.
  assert.deepEqual(tiktok!.cuts.map((c) => c?.views ?? null), [210000, null]);
  assert.equal(tiktok!.latest, null);
  assert.equal(p.result?.views, 712000);
  assert.deepEqual(p.result?.missingInputs, ['brand_csv_sales']);
  assert.equal(p.result?.attributedRevenue, '8400000.00');
  assert.equal(p.brandFollowers?.handle, 'cafealma');
  assert.equal(p.brandFollowers?.baselineFrom, '2026-07-27');
  assert.deepEqual(p.brandFollowers?.points, [
    { day: '2026-07-27', followers: 18400 },
    { day: '2026-08-10', followers: 18560 },
    { day: '2026-08-11', followers: 18700 },
  ]);
  assert.equal(p.brandInputs.length, 2);
  assert.equal(p.brandInputs[1]?.value, '8400000.00');
});

test('el enlace rastreado se guarda sin parámetros y el código tal cual', () => {
  const p = construirReporte(entradasCafeAlma());
  assert.equal(p.campaign.trackingUrl, 'https://cafealma.co/cold-brew');
  assert.equal(p.campaign.trackingCode, 'LAURA15');
  assert.equal(trackingUrlSinParametros('https://x.co/a/b?x=1#frag'), 'https://x.co/a/b');
  assert.equal(trackingUrlSinParametros('no es url'), null);
  assert.equal(trackingUrlSinParametros('javascript:alert(1)'), null);
  assert.equal(trackingUrlSinParametros(null), null);
});

test('sin PII ni datos privados: el volcado de texto del payload está limpio (§0.3.6)', () => {
  const entradas = entradasCafeAlma();
  // Lo que la consulta podría traer de más y NO puede pasar.
  (entradas.brandInputs[0] as unknown as Record<string, unknown>).notes = 'Reportado por ana@cafealma.co, tel +57 300 123 4567';
  (entradas.campaign as unknown as Record<string, unknown>).brief = 'brief privado';
  (entradas as unknown as Record<string, unknown>).dealId = '00000000-0000-4000-8000-000000000001';
  const json = JSON.stringify(construirReporte(entradas));
  assert.equal(reportForbiddenMatch(json), null, json);
  assert.ok(!json.includes('utm_'));
  assert.ok(!json.includes('brief privado'));
  assert.ok(!json.includes('cafealma.co,'));
  // Y el detector sí detecta: si alguien mete un correo o un teléfono, la prueba de db lo verá.
  assert.equal(reportForbiddenMatch('{"x":"ana@cafealma.co"}'), 'correo');
  assert.equal(reportForbiddenMatch('{"x":"+57 300 123 4567"}'), 'teléfono');
  assert.equal(reportForbiddenMatch('{"x":"https://a.co/?utm_source=x"}'), 'utm');
  assert.equal(reportForbiddenMatch('{"notes":"x"}'), 'notas de la marca');
  assert.equal(reportForbiddenMatch('{"campaignId":"x"}'), 'ids internos');
  // Un ISO y una cifra grande no son teléfonos, y la query de un post de YouTube no es una UTM.
  assert.equal(reportForbiddenMatch('{"capturedAt":"2026-09-10T06:00:00Z","views":712000,"url":"https://www.youtube.com/watch?v=demo-d05"}'), null);
});

test('sin cotización, sin resultado, sin curva y sin posts: nulos y listas vacías, nunca ceros', () => {
  const e = entradasCafeAlma();
  e.agreed = null;
  e.result = null;
  e.brandFollowers = null;
  e.posts = [];
  e.brandInputs = [];
  e.creator = null;
  const p = construirReporte(e);
  assert.equal(p.agreed, null);
  assert.equal(p.result, null);
  assert.equal(p.brandFollowers, null);
  assert.deepEqual(p.posts, []);
  assert.deepEqual(p.brandInputs, []);
  assert.deepEqual(p.cutsHours, [168, 720]);
  assert.deepEqual(p.creator, { displayName: '', handle: null });
});

test('reportCutsHours: los acordados que existen en la vista, o 7 y 30 días', () => {
  assert.deepEqual(reportCutsHours([24, 168, 720]), [24, 168, 720]);
  assert.deepEqual(reportCutsHours([48, 999]), [168, 720]);
  assert.deepEqual(reportCutsHours([]), [168, 720]);
  assert.deepEqual(reportCutsHours(null), [168, 720]);
});

test('isReportPayloadV1 rechaza lo que no es de esta versión', () => {
  assert.equal(isReportPayloadV1(null), false);
  assert.equal(isReportPayloadV1({ version: 2, campaign: {}, posts: [], cutsHours: [] }), false);
  assert.equal(isReportPayloadV1({ version: 1, campaign: {}, posts: [], cutsHours: [] }), true);
});

// -------------------------------------------------------------- reglas

test('solo se reporta una campaña que ya publicó', () => {
  for (const s of CAMPAIGN_STATUSES) {
    assert.equal(canGenerateReport(s), REPORTABLE_CAMPAIGN_STATUSES.includes(s), s);
  }
  assert.equal(canGenerateReport('planned'), false);
  assert.equal(canGenerateReport('cancelled'), false);
  assert.equal(canGenerateReport('measuring'), true);
});

test('los errores llevan messageEs y el estado de cada reporte tiene etiqueta', () => {
  assert.match(new ReportNotAvailableError('planned').messageEs, /planeada/);
  assert.match(new ReportNotAvailableError('cancelled').messageEs, /cancelada/);
  assert.match(new ReportAlreadySentError().messageEs, /ya se marcó/);
  assert.match(new ReportNotSendableError('email').messageEs, /email/);
  assert.equal(REPORT_STATUS_META.viewed.label, 'Visto por la marca');
  assert.equal(REPORT_SENT_VIA_LABEL_ES.pdf, 'como PDF');
  assert.equal(isReportSentViaMvp('link'), true);
  assert.equal(isReportSentViaMvp('email'), false);
});

test('el título de un post sin título es la primera línea de la caption, sin correos ni teléfonos', () => {
  assert.equal(tituloParaLaMarca(null, 'Cold brew ☕ con @cafealma\nPedidos: laura@gmail.com'), 'Cold brew ☕ con @cafealma');
  assert.equal(tituloParaLaMarca(null, 'Escríbeme a laura@gmail.com o al +57 300 123 4567'), `Escríbeme a ${DATO_OMITIDO} o al ${DATO_OMITIDO}`);
  assert.equal(tituloParaLaMarca(null, 'Llama al 300 123 4567'), `Llama al ${DATO_OMITIDO}`);
  assert.equal(tituloParaLaMarca('Título propio', 'caption'), 'Título propio');
  assert.equal(tituloParaLaMarca(null, null), null);
  assert.equal(tituloParaLaMarca(null, '   '), null);
  assert.equal(tituloParaLaMarca(null, 'x'.repeat(300))!.length, 140);
  const e = entradasCafeAlma();
  e.posts[0]!.caption = 'Receta\ncontacto: laura@gmail.com +57 300 123 4567';
  e.posts[1]!.caption = 'Pedidos a laura@gmail.com';
  assert.equal(reportForbiddenMatch(JSON.stringify(construirReporte(e))), null);
  assert.match(new ReportPayloadRejectedError('correo').messageEs, /correo/);
});
