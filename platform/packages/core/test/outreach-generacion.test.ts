/**
 * VEN-12 · el renderizador único, las afirmaciones trazables, las tres
 * compuertas y el pre-vuelo. Puro, sin base ni red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimsCitedIn, figureMatchesClaim, findClaimMarkers, findFigures, stripClaimMarkers, type FigureHit, type SalesClaim,
} from '../src/outreach/claims.ts';
import { createFakeGenerator } from '../src/outreach/fake.ts';
import type { GenerationInput } from '../src/outreach/generate.ts';

type FigureKind = FigureHit['kind'];
import {
  bodyFingerprint, idempotencyGate, jaccard, shingles, similarityGate, similarityThreshold, subjectGate, textSimilarity,
} from '../src/outreach/gates.ts';
import { checkFigures, markFiguresByValue, preflight, questionCloses, shoutingIn, unsourcedFigures } from '../src/outreach/preflight.ts';
import { formatClaimValue, formatShare } from '../src/outreach/claim-labels.ts';
import {
  PERSON_VARIABLES, renderTemplate, TEMPLATE_VARIABLES, templateValuesFrom, templateVariablesIn, templatizeKnownValues, templatizePeople,
} from '../src/outreach/render.ts';

const CLAIMS: SalesClaim[] = [
  {
    id: 'baseline:tiktok:median_views', source: 'creator_baseline', label: 'Mediana de views en TikTok', value: 115446,
    unit: 'count', display: '115.446', ref: { table: 'creator_baseline', id: 'b1' },
  },
  {
    id: 'audience:tiktok:age:25-34', source: 'creator_profile', label: 'Audiencia de 25 a 34 años en TikTok', value: 0.37,
    unit: 'share', display: '37 %', ref: { table: 'audience_breakdown', id: 'a1' },
  },
  {
    id: 'post:d01:views_vs_median', source: 'post_score', label: 'Cold brew en casa: views frente a la mediana', value: 6.7,
    unit: 'multiple', display: '6,7×', ref: { table: 'post_score', id: 'd01' },
  },
];

// ---------------------------------------------------------------------
// Renderizador
// ---------------------------------------------------------------------

test('el renderizador es uno: la lista canónica cubre contacto, empresa, señal y creador', () => {
  for (const v of ['first_name', 'company', 'signal_headline', 'sender_name', 'media_kit_url']) {
    assert.ok((TEMPLATE_VARIABLES as readonly string[]).includes(v), v);
  }
  const values = templateValuesFrom({
    contact: { fullName: 'Sofía Cárdenas', roleTitle: 'Marca' },
    company: { name: 'Vitalé' },
    signal: { headline: 'Lanzó snacks el 2 sep' },
    creator: { senderName: 'Laura', handle: 'laura.cocinafacil' },
  });
  assert.equal(
    renderTemplate('Hola, {{first_name}}. Vi que {{company}}: {{signal_headline}}. Soy {{sender_name}} ({{creator_handle}}).', values),
    'Hola, Sofía. Vi que Vitalé: Lanzó snacks el 2 sep. Soy Laura (@laura.cocinafacil).',
  );
  // Lo que falta se queda a la vista para la guardia de huecos.
  assert.equal(renderTemplate('{{quote_url}} {{apodo}}', values), '{{quote_url}} {{apodo}}');
  assert.deepEqual(templateVariablesIn('{{company}} {{ company }} {{apodo}}'), { known: ['company'], unknown: ['apodo'] });
});

// ---------------------------------------------------------------------
// Afirmaciones
// ---------------------------------------------------------------------

test('las marcas se encuentran, se quitan y dicen qué claims se citaron', () => {
  const t = 'Mis videos tienen 115.446 views [claim:baseline:tiktok:median_views] de mediana.';
  assert.deepEqual(findClaimMarkers(t).map((m) => m.id), ['baseline:tiktok:median_views']);
  assert.equal(stripClaimMarkers(t), 'Mis videos tienen 115.446 views de mediana.');
  assert.deepEqual(claimsCitedIn(CLAIMS, t, '[claim:no-existe]').map((c) => c.id), ['baseline:tiktok:median_views']);
});

test('las cifras: miles, decimales, porcentajes, múltiplos y escalas; fechas, horas, años y conteos pequeños no cuentan', () => {
  const hits = findFigures('115.446 views, 37 % de 25 a 34 y 18-24, 6,7x la mediana, 400 mil seguidores y 1,2 millones.');
  assert.deepEqual(hits.map((h) => h.raw), ['115.446', '37 %', '6,7x', '400 mil', '1,2 millones']);
  assert.ok(hits[0]!.values.includes(115446));
  assert.ok(hits[1]!.values.includes(0.37));
  assert.ok(hits[3]!.values.includes(400000));
  assert.deepEqual(findFigures('Hablamos el 15 de octubre a las 10:30, en 2026, con 3 ideas: https://x.co/a/123456'), []);
  assert.equal(figureMatchesClaim(findFigures('115 mil')[0]!, CLAIMS[0]!), true);
  assert.equal(figureMatchesClaim(findFigures('150 mil')[0]!, CLAIMS[0]!), false);
});

// El sondeo de la ronda 2: cada uno de estos pasaba el pre-vuelo sin origen.
test('una cifra pequeña con un sustantivo de desempeño detrás necesita su origen: «trabajé con 11 marcas»', () => {
  assert.deepEqual(checkFigures('Trabajé con 11 marcas este año.', CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', '11']]);
  assert.deepEqual(checkFigures('Trabajé con 11 grandes marcas.', CLAIMS).map((i) => i.code), ['unsourced_figure']);
});

test('«12 videos» también es una cifra; «3 ideas de video» no', () => {
  assert.deepEqual(checkFigures('Publiqué 12 videos con marcas de cocina.', CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', '12']]);
  assert.deepEqual(checkFigures('Te mando 3 ideas de video para el lanzamiento.', CLAIMS), []);
});

test('«2000 seguidores» es una cifra, no un año; «en 2026» sigue siendo un año', () => {
  assert.deepEqual(checkFigures('Gané 2000 seguidores con esa serie.', CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', '2000']]);
  assert.deepEqual(checkFigures('En 2026 lancé la serie de desayunos. Desde 2025 publico cada semana.', CLAIMS), []);
});

test('los números escritos con palabras se detectan: «diez mil views», «el triple», «once marcas», «un millón»', () => {
  const casos: Array<[string, string, number]> = [
    ['Ese video pasó las diez mil views sin pauta.', 'diez mil', 10_000],
    ['Mis videos de desayuno tienen el triple de views.', 'triple', 3],
    ['Trabajé con once marcas de alimentos.', 'once', 11],
    ['Llegué a un millón de reproducciones.', 'un millón', 1_000_000],
    ['I got ten thousand views on that video.', 'ten thousand', 10_000],
    ['My breakfast videos get twice the views.', 'twice', 2],
    ['Llevo treinta y dos colaboraciones.', 'treinta y dos', 32],
  ];
  for (const [texto, raw, valor] of casos) {
    const hits = findFigures(texto);
    assert.deepEqual(hits.map((h) => [h.raw, h.values[0]]), [[raw, valor]], texto);
    assert.deepEqual(checkFigures(texto, CLAIMS).map((i) => i.code), ['unsourced_figure'], texto);
  }
  // Con su origen, pasa: «el triple» frente a un claim de 3,1×.
  const triple: SalesClaim = { ...CLAIMS[2]!, id: 'post:d02:views_vs_median', value: 3.1, display: '3,1×' };
  assert.deepEqual(checkFigures('Ese video tuvo el triple [claim:post:d02:views_vs_median] de mi mediana.', [triple]), []);
  // No son cifras: un artículo, una fórmula, dos ideas.
  assert.deepEqual(findFigures('Un video, mil gracias, dos ideas de receta, a la semana, one of the brands.'), []);
  // «400 mil» es una sola cifra: la palabra «mil» no cuenta dos veces.
  assert.deepEqual(findFigures('400 mil seguidores').map((h) => h.raw), ['400 mil']);
});

// Ronda 3: lo que el pre-vuelo no veía y lo que veía de más.
test('un multiplicador delante, un puesto, «3-fold» y los puntos porcentuales son cifras siempre, por pequeñas que sean', () => {
  const casos: Array<[string, string, string]> = [
    ['Con mi último video las ventas crecieron x3.', 'x3', 'multiple'],
    ['Las ventas crecieron ×2 en una semana.', '×2', 'multiple'],
    ['Soy la creadora #1 de recetas en Colombia.', '#1', 'rank'],
    ['Estuve en el top 1 de TikTok.', 'top 1', 'rank'],
    ['Soy la número uno en recetas de desayuno.', 'número uno', 'rank'],
    ["I'm the number one creator in my niche.", 'number one', 'rank'],
    ['My engagement grew 3-fold this year.', '3-fold', 'multiple'],
    ['La interacción subió 5 pp en un mes.', '5 pp', 'percent'],
  ];
  for (const [texto, raw, kind] of casos) {
    assert.deepEqual(findFigures(texto).map((h) => [h.raw, h.kind]), [[raw, kind]], texto);
    assert.deepEqual(checkFigures(texto, CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', raw]], texto);
  }
  // Un puesto no lo respalda ninguna cifra del perfil, aunque lleve una marca.
  const uno: SalesClaim = { ...CLAIMS[0]!, id: 'x:uno', value: 1, display: '1' };
  assert.deepEqual(checkFigures('Soy la #1 [claim:x:uno] de mi nicho.', [uno]).map((i) => i.code), ['claim_mismatch']);
  // Un hashtag con números no es un puesto; un multiplicador con su origen, sí pasa.
  assert.deepEqual(findFigures('Súmate al #2024challenge'), []);
  const triple: SalesClaim = { ...CLAIMS[2]!, id: 'post:d02:views_vs_median', value: 3.1, display: '3,1×' };
  assert.deepEqual(checkFigures('Ese video hizo x3 [claim:post:d02:views_vs_median] mi mediana.', [triple]), []);
});

test('lo normal de una propuesta no es una cifra: entregables que se ofrecen, duraciones y direcciones', () => {
  for (const texto of [
    'Te propongo 3 videos para el lanzamiento.',
    'Un reel de 30 segundos con la receta.',
    'Grabo en 48 horas y te lo mando.',
    'Pasé por su local de la calle 85 y me encantó.',
    'Mis 3 mejores videos son de desayunos.',
    'Te propongo 3 videos y 2 historias para la semana.',
    'El paquete de 4 reels incluye 2 historias.',
    'Lo entrego de 2 a 3 semanas después.',
    'Nos vemos en la Cra. 7 # 71-21.',
    'Te propongo tres videos cortos.',
  ]) {
    assert.deepEqual(checkFigures(texto, CLAIMS), [], texto);
  }
  // Pero un resultado sigue siendo una cifra: «publiqué 12 videos», «11 marcas», «2 millones de views».
  assert.deepEqual(checkFigures('Publiqué 12 videos con marcas de cocina.', CLAIMS).map((i) => i.code), ['unsourced_figure']);
  assert.deepEqual(checkFigures('Te propongo algo: trabajé con 11 marcas.', CLAIMS).map((i) => i.code), ['unsourced_figure']);
  assert.deepEqual(checkFigures('En 48 horas llegué a 2 millones de views.', CLAIMS).map((i) => i.detail), ['2 millones']);
});

test('«medio millón» es 500.000 y «a miles» dice «miles»', () => {
  assert.deepEqual(findFigures('Llegué a medio millón de views.').map((h) => [h.raw, h.values[0]]), [['medio millón', 500_000]]);
  assert.deepEqual(findFigures('Van un millón y medio de reproducciones.').map((h) => [h.raw, h.values[0]]), [['un millón y medio', 1_500_000]]);
  assert.deepEqual(findFigures('Llegué a miles de personas.').map((h) => [h.raw, h.values[0]]), [['miles', 1_000]]);
  assert.deepEqual(findFigures('I reached a million people.').map((h) => h.raw), ['million']);
  // Una cita correcta de 500.000 escrita como «medio millón» coincide con su claim.
  const medio: SalesClaim = { ...CLAIMS[0]!, id: 'baseline:ig:median_views', value: 500_000, display: '500.000' };
  assert.deepEqual(checkFigures('Mis reels tienen medio millón [claim:baseline:ig:median_views] de views.', [medio]), []);
  // «media hora» no es una cifra.
  assert.deepEqual(findFigures('Lo grabo en media hora.'), []);
});

test('una cifra que coincide con una del perfil recibe su marca; la que no coincide se queda sin ella', () => {
  const marcado = markFiguresByValue('Mi mediana es 115.446 views y el 37 % tiene 25 a 34. Crecí x9 este año.', CLAIMS);
  assert.equal(
    marcado,
    'Mi mediana es 115.446 [claim:baseline:tiktok:median_views] views y el 37 % [claim:audience:tiktok:age:25-34] tiene 25 a 34. Crecí x9 este año.',
  );
  assert.deepEqual(checkFigures(marcado, CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', 'x9']]);
  // Lo que ya tenía marca no se marca dos veces.
  const ya = 'Tengo 115.446 views [claim:baseline:tiktok:median_views].';
  assert.equal(markFiguresByValue(ya, CLAIMS), ya);
});

test('por valor, la unidad tiene que encajar, y lo que la IA dejó sin origen no se respalda tocando una coma', () => {
  const conMultiplo: SalesClaim[] = [
    ...CLAIMS,
    { id: 'post:d02:views_vs_median', source: 'post_score', label: 'Views frente a la mediana', value: 1.24, unit: 'multiple', display: '1,2×', ref: { table: 'post_score', id: 'd02' } },
    { id: 'campaign:c1:brand_followers', source: 'campaign_result', label: 'Seguidores nuevos de la marca', value: 1240, unit: 'count', display: '1.240', ref: { table: 'campaign_report', id: 'c1' } },
  ];
  // «1.240» se lee 1240 o 1,24: un número suelto lo respalda el conteo, nunca el múltiplo de 1,24×.
  assert.equal(
    markFiguresByValue('Gané 1.240 seguidores.', conMultiplo.filter((c) => c.unit === 'multiple')),
    'Gané 1.240 seguidores.',
  );
  assert.equal(markFiguresByValue('Gané 1.240 seguidores.', conMultiplo), 'Gané 1.240 [claim:campaign:c1:brand_followers] seguidores.');
  // Un 37 % coincide con la audiencia de 25 a 34 años, pero si la IA lo dejó sin marca, sigue sin origen.
  const ia = 'El 37 % de mis videos termina en una compra.';
  assert.deepEqual(unsourcedFigures(ia, CLAIMS), ['37 %']);
  const editado = 'El 37% de mis videos termina en una compra, de verdad.';
  assert.equal(markFiguresByValue(editado, CLAIMS, { skip: unsourcedFigures(ia, CLAIMS) }), editado);
  assert.deepEqual(checkFigures(editado, CLAIMS).map((i) => i.code), ['unsourced_figure']);
  // Una cifra nueva que escribió la persona sí se respalda por valor.
  assert.equal(
    markFiguresByValue('Mi mediana es 115.446 views.', CLAIMS, { skip: ['37 %'] }),
    'Mi mediana es 115.446 [claim:baseline:tiktok:median_views] views.',
  );
});

test('una cifra sin marca, con marca desconocida o con otro valor no pasa', () => {
  assert.deepEqual(checkFigures('Tengo 115.446 views [claim:baseline:tiktok:median_views].', CLAIMS), []);
  assert.deepEqual(checkFigures('Tengo 500.000 views de mediana.', CLAIMS).map((i) => i.code), ['unsourced_figure']);
  assert.deepEqual(checkFigures('Tengo 90 % de mujeres [claim:inventado].', CLAIMS).map((i) => i.code), ['unknown_claim']);
  assert.deepEqual(checkFigures('Un 52 % [claim:audience:tiktok:age:25-34] tiene 25 a 34.', CLAIMS).map((i) => i.code), ['claim_mismatch']);
  // La marca de una cifra no sirve para la siguiente.
  assert.deepEqual(
    checkFigures('115.446 y 37 % [claim:audience:tiktok:age:25-34].', CLAIMS).map((i) => i.code),
    ['unsourced_figure'],
  );
  // El ángulo decide de qué orígenes se puede citar.
  assert.deepEqual(
    checkFigures('Un video hizo 6,7× [claim:post:d01:views_vs_median] mi mediana.', CLAIMS, ['creator_profile']).map((i) => i.code),
    ['claim_not_for_this_angle'],
  );
});

// ---------------------------------------------------------------------
// Compuertas
// ---------------------------------------------------------------------

test('compuerta A: asunto presente, sin huecos, de 2 a 12 palabras, menos de 80 caracteres y «Re:» solo en respuestas', () => {
  assert.deepEqual(subjectGate('email', 'Tu cold brew y mi audiencia de Bogotá'), { ok: true, codes: [] });
  assert.deepEqual(subjectGate('email', '').codes, ['subject_missing']);
  assert.deepEqual(subjectGate('email', 'Hola').codes, ['subject_too_short']);
  assert.deepEqual(subjectGate('email', 'Re: tu campaña de octubre').codes, ['subject_fake_reply']);
  assert.deepEqual(subjectGate('email', 'Hola {{first_name}}, una idea').codes, ['subject_placeholders']);
  assert.ok(subjectGate('email', 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece').codes.includes('subject_too_many_words'));
  assert.ok(subjectGate('email', `Una idea ${'larguísima '.repeat(8)}`).codes.includes('subject_too_long'));
  assert.deepEqual(subjectGate('email_reply', null), { ok: true, codes: [] });
  assert.deepEqual(subjectGate('email_reply', 'Re: tu cold brew'), { ok: true, codes: [] });
  assert.deepEqual(subjectGate('linkedin_message', 'Asunto').codes, ['subject_not_allowed']);
});

test('compuerta B: Jaccard sobre 5-shingles, 0,65 en directos y 0,80 en correo', () => {
  assert.equal(similarityThreshold('email'), 0.8);
  assert.equal(similarityThreshold('linkedin_message'), 0.65);
  const a = 'Hola Sofía, vi el lanzamiento de sus snacks y creo que mi audiencia de Medellín es justo su cliente.';
  assert.equal(textSimilarity(a, a), 1);
  assert.equal(jaccard(shingles(''), shingles('')), 0);
  const cambiado = a.replace('Sofía', 'Daniel').replace('snacks', 'granolas');
  const v = similarityGate('linkedin_message', cambiado, ['Otro texto que no se parece en nada al mensaje', a]);
  assert.equal(v.closest, 1);
  assert.ok(v.max > 0.3 && v.max < 1);
  const otro = similarityGate('email', 'Un mensaje escrito de cero, con otra idea y otro orden de las palabras.', [a]);
  assert.equal(otro.ok, true);
  const copia = similarityGate('email', `${a} `, [a]);
  assert.deepEqual([copia.ok, copia.codes], [false, ['too_similar']]);
});

test('compuerta C: solo se escribe sobre un borrador con el turno propio y sin repetir lo que ya le llegó', () => {
  const f = bodyFingerprint('Asunto', 'Cuerpo del mensaje [claim:x]');
  assert.equal(f, bodyFingerprint('asunto', 'Cuerpo  del mensaje'));
  assert.deepEqual(idempotencyGate({ touchStatus: 'draft', leaseHeld: true, fingerprint: f, sentToContact: [] }), { ok: true, codes: [] });
  assert.deepEqual(
    idempotencyGate({ touchStatus: 'scheduled', leaseHeld: false, fingerprint: f, sentToContact: [f] }).codes,
    ['touch_not_draft', 'lease_lost', 'already_sent_to_contact'],
  );
  // Una persona escribió en el borrador mientras el job trabajaba: su texto manda.
  assert.deepEqual(
    idempotencyGate({ touchStatus: 'draft', leaseHeld: true, fingerprint: f, sentToContact: [], bodyUnchanged: false }).codes,
    ['edited_by_person'],
  );
});

// ---------------------------------------------------------------------
// Pre-vuelo
// ---------------------------------------------------------------------

const BUEN_CORREO = [
  'Hola Sofía,',
  '',
  'Vi que Vitalé lanzó su línea de snacks este mes y pensé en mi audiencia: el 37 % [claim:audience:tiktok:age:25-34] de quienes me ven en TikTok tiene entre 25 y 34 años, justo quien compra un snack para la oficina.',
  '',
  'Mis recetas rápidas tienen una mediana de 115.446 views [claim:baseline:tiktok:median_views] y la gente las guarda para cocinarlas en la semana.',
  '',
  '¿Te sirve que te cuente una idea de video para el lanzamiento?',
  '',
  'Laura',
].join('\n');

function correo(body: string, extra: Partial<Parameters<typeof preflight>[0]> = {}) {
  return preflight({ stepType: 'email', subject: 'Tus snacks y mi audiencia en Medellín', body, claims: CLAIMS, firstTouch: true, ...extra });
}

test('un correo bien hecho pasa el pre-vuelo y sale sin marcas', () => {
  const r = correo(BUEN_CORREO);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
  assert.equal(r.hint, null);
  assert.ok(!r.cleanBody.includes('[claim:'));
  assert.ok(r.cleanBody.includes('el 37 % de quienes me ven'));
});

test('terminado cuando: un mensaje con una cifra sin claim no pasa el pre-vuelo, y es un riesgo', () => {
  const r = correo(BUEN_CORREO.replace('115.446 views [claim:baseline:tiktok:median_views]', '500.000 views'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.map((i) => i.code), ['unsourced_figure']);
  assert.deepEqual(r.riskTriggers, ['unsourced_figure']);
  assert.equal(r.hint, 'add_proof');
});

test('el pre-vuelo ve estilo, estructura y riesgos sin gastar tokens', () => {
  const casos: Array<[string, string]> = [
    [BUEN_CORREO.replace('Vi que', 'Espero que este correo te encuentre bien. Vi que'), 'ai_filler'],
    [BUEN_CORREO.replace('pensé en', 'hay sinergia con'), 'banned_word'],
    [BUEN_CORREO.replace('Leverage', '').replace('pensé en', 'we could leverage'), 'banned_word'],
    [BUEN_CORREO.replace('este mes y', 'este mes — y'), 'long_dash'],
    [BUEN_CORREO.replace('este mes y', 'este mes; y'), 'semicolon'],
    [BUEN_CORREO.replace('Vi que', 'MIRA ESTO, vi que'), 'shouting'],
    [BUEN_CORREO.replace('Vi que Vitalé', '¿Viste mi perfil? Vitalé'), 'too_many_questions'],
    [BUEN_CORREO.replace('¿Te sirve que te cuente una idea de video para el lanzamiento?', 'Te cuento una idea cuando quieras.'), 'missing_closing_question'],
    [BUEN_CORREO.replace('¿Te sirve que te cuente una idea de video para el lanzamiento?', 'Te cuento una idea de video para el lanzamiento.').replace('Vi que', '¿Viste mi último video? Vi que'), 'question_not_closing'],
    [BUEN_CORREO.replace('Laura', 'Laura · https://calendly.com/laura/15min'), 'calendar_link_first_touch'],
    [BUEN_CORREO.replace('Vi que', 'Es la última oportunidad: vi que'), 'false_urgency'],
    [BUEN_CORREO.replace('Hola Sofía,', 'Hola {{first_name}},'), 'placeholders'],
    [BUEN_CORREO.repeat(4), 'too_long'],
    ['Hola, ¿hablamos?', 'too_short'],
  ];
  for (const [body, code] of casos) {
    const r = correo(body);
    assert.ok(r.issues.some((i) => i.code === code), `${code}: ${JSON.stringify(r.issues)}`);
    assert.equal(r.ok, false, code);
    assert.notEqual(r.hint, null, code);
  }
  assert.deepEqual(correo(BUEN_CORREO.replace('Vi que', 'Es la última oportunidad: vi que')).riskTriggers, ['false_urgency']);
  // El calendario sí vale después del primer toque.
  assert.equal(correo(BUEN_CORREO.replace('Laura', 'Laura · https://calendly.com/laura/15min'), { firstTouch: false }).ok, true);
  // La rúbrica del paso manda sobre el largo por defecto.
  assert.ok(correo(BUEN_CORREO, { maxChars: 300 }).issues.some((i) => i.code === 'too_long'));
});

test('las siglas y la marca en mayúsculas no son gritar; la pregunta de cierre puede ir antes de la firma', () => {
  assert.deepEqual(shoutingIn('Un video UGC con ROI medido para NIVEA', ['NIVEA']), []);
  // Una marca de varias palabras vale palabra por palabra.
  assert.deepEqual(shoutingIn('Una idea para CAFÉ ALMA en Bogotá', ['Café Alma']), []);
  assert.deepEqual(shoutingIn('Es GRATIS y YA'), ['GRATIS']);
  assert.equal(questionCloses('Idea.\n\n¿Te sirve?\n\nLaura'), true);
  assert.equal(questionCloses('¿Te sirve?\n\nUna idea larga que sigue después de la pregunta y no es una firma para nada.'), false);
  // Un comentario público no necesita pregunta y no lleva asunto.
  const comentario = preflight({ stepType: 'linkedin_comment', body: 'Qué buena la idea del empaque retornable para la ciudad.', claims: [], firstTouch: true });
  assert.equal(comentario.ok, true);
});

test('un correo corto y bueno (unas 35 palabras) pasa el largo; uno que no dice nada, no', () => {
  const corto = [
    'Hola Sofía,',
    '',
    'Vi los snacks nuevos de Vitalé. Mis recetas tienen una mediana de 115.446 views [claim:baseline:tiktok:median_views] y encajan con su lanzamiento.',
    '',
    '¿Te mando una idea?',
    '',
    'Laura',
  ].join('\n');
  const r = correo(corto);
  assert.ok(!r.issues.some((i) => i.code === 'too_short'), JSON.stringify(r.issues));
  assert.ok(correo('Hola, ¿hablamos esta semana?\n\nLaura').issues.some((i) => i.code === 'too_short'));
});

test('compuerta B: el mismo correo con el nombre de la marca y de la persona cambiados es el mismo correo', () => {
  const a = 'Hola Camilo,\n\nVi que Café Alma lanzó su cold brew en botella y pensé en quien me ve en Bogotá cada mañana.\n\n¿Te interesa que te mande una idea?\n\nLaura';
  const b = a.replace('Camilo', 'Camila').replace('Café Alma', 'Fresko Market').replace('Bogotá', 'Medellín');
  assert.equal(textSimilarity(a, b), 1);
  assert.deepEqual(similarityGate('email', b, [a]).codes, ['too_similar']);
});

// ---------------------------------------------------------------------
// Ronda 4: las cifras en palabras que se escapaban y los conteos del perfil sin marca
// ---------------------------------------------------------------------

test('porcentajes, fracciones, proporciones, múltiplos conjugados y puestos en palabras son cifras sin sustantivo detrás', () => {
  const casos: Array<[string, string, FigureKind, number]> = [
    ['El ochenta por ciento de mi audiencia toma café.', 'ochenta por ciento', 'percent', 0.8],
    ['Un veinte por ciento compra en línea.', 'veinte por ciento', 'percent', 0.2],
    ['Eighty percent of my audience drinks coffee.', 'Eighty percent', 'percent', 0.8],
    ['La mitad de mis seguidores vive en Medellín.', 'mitad', 'percent', 0.5],
    ['Half of my followers are in Bogotá.', 'Half', 'percent', 0.5],
    ['Dos tercios de mi audiencia son mujeres.', 'Dos tercios', 'percent', 0.667],
    ['Tres de cada cuatro seguidoras cocinan en casa.', 'Tres de cada cuatro', 'percent', 0.75],
    ['9 out of 10 followers cook at home.', '9 out of 10', 'percent', 0.9],
    ['Con esa marca triplicamos las ventas del mes.', 'triplicamos', 'multiple', 3],
    ['Con mi video duplicamos las ventas.', 'duplicamos', 'multiple', 2],
    ['Tu marca duplicó sus pedidos conmigo.', 'duplicó', 'multiple', 2],
    ['That video ended up tripling their sales.', 'tripling', 'multiple', 3],
    // Ronda 5: la «c» pasa a «qu» delante de «e».
    ['Dupliqué las ventas de la marca.', 'Dupliqué', 'multiple', 2],
    ['Cuadrupliqué mis seguidores con esa serie.', 'Cuadrupliqué', 'multiple', 4],
    ['Dupliquemos tus pedidos este trimestre.', 'Dupliquemos', 'multiple', 2],
    ['Quintupliqué los guardados del reel.', 'Quintupliqué', 'multiple', 5],
    ['Quedé en primer lugar del reto de recetas.', 'primer lugar', 'rank', 1],
    ['Quedé en 1er lugar del reto de recetas.', '1er lugar', 'rank', 1],
    ['I was the first creator to review it.', 'first creator', 'rank', 1],
  ];
  for (const [texto, raw, kind, valor] of casos) {
    assert.deepEqual(findFigures(texto).map((h) => [h.raw, h.kind, h.values[0]]), [[raw, kind, valor]], texto);
    assert.deepEqual(checkFigures(texto, CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', raw]], texto);
  }
  // Con su origen, pasan: «el ochenta por ciento» frente a un 80 %, «la mitad» frente a un 51 %.
  const ochenta: SalesClaim = { ...CLAIMS[1]!, id: 'audience:tiktok:gender:f', value: 0.8, display: '80 %' };
  assert.deepEqual(checkFigures('El ochenta por ciento [claim:audience:tiktok:gender:f] de mi audiencia son mujeres.', [ochenta]), []);
  const mitad: SalesClaim = { ...CLAIMS[1]!, id: 'audience:tiktok:country:co', value: 0.51, display: '51 %' };
  assert.deepEqual(checkFigures('La mitad [claim:audience:tiktok:country:co] de mis seguidores vive en Colombia.', [mitad]), []);
  // No son cifras: el tiempo, un ordinal, una fecha relativa.
  for (const texto of [
    'Lo grabo en media hora.', 'Nos vemos a mitad de semana.', 'It takes half an hour.', 'El cuarto video de la serie.',
    'Un cuarto de hora y listo.', 'Hace 2 años trabajé con ellos.', 'Mi primer video fue de desayunos.',
  ]) {
    assert.deepEqual(findFigures(texto), [], texto);
  }
  assert.deepEqual(findFigures('I reached half a million people.').map((h) => [h.raw, h.values[0]]), [['half a million', 500_000]]);
});

test('terminado cuando (ronda 4): el correo del revisor con cifras en palabras no pasa el pre-vuelo', () => {
  const body =
    'Hola Sofía,\n\nEl ochenta por ciento de mi audiencia toma café a diario y con la última marca de bebidas triplicamos las ventas del mes. ' +
    'La mitad de mis seguidores vive en Medellín.\n\n¿Te cuento la idea?\n\nLaura';
  const r = preflight({ stepType: 'email', subject: 'Una idea para Café Alma', body, claims: [], firstTouch: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.filter((i) => i.code === 'unsourced_figure').map((i) => i.detail), ['ochenta por ciento', 'triplicamos', 'mitad']);
  assert.deepEqual(r.riskTriggers, ['unsourced_figure']);
});

const ADS: SalesClaim = {
  id: 'signal:s1:active_ads', source: 'signal', label: 'Anuncios activos de Fresko Market', value: 6, unit: 'count', display: '6',
  ref: { table: 'signal', id: 's1' },
};

test('un número de la marca sin su marca [claim] no pasa: «6 anuncios activos» es la cifra de la señal', () => {
  const body =
    'Hola Sofía,\n\nLo de Fresko Market (6 anuncios activos en Meta desde el 12 ago) es justo lo que mi audiencia sigue de cerca. ' +
    'Me imagino una serie corta con sus productos en la rutina real de quien me ve.\n\n¿Te interesa que te mande la idea completa?\n\nLaura';
  const r = preflight({ stepType: 'email', subject: 'Una idea para Fresko Market', body, claims: [...CLAIMS, ADS], firstTouch: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.map((i) => [i.code, i.detail]), [['unsourced_figure', '6']]);
  assert.deepEqual(r.riskTriggers, ['unsourced_figure']);
  // Con su marca, pasa: la cifra tiene origen.
  const marcado = preflight({
    stepType: 'email', subject: 'Una idea para Fresko Market', body: body.replace('(6 anuncios', '(6 [claim:signal:s1:active_ads] anuncios'),
    claims: [...CLAIMS, ADS], firstTouch: true,
  });
  assert.deepEqual(marcado.issues, []);
  // La trayectoria también se afirma: «9 años creando contenido».
  assert.deepEqual(checkFigures('Tengo 9 años creando contenido de cocina.', CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', '9']]);
  // Un conteo del perfil con un sustantivo fuera de la lista: basta con que diga lo que cuenta la etiqueta.
  const locales: SalesClaim = { ...ADS, id: 'signal:s2:stores', label: 'Locales abiertos de Fresko Market', value: 4, display: '4' };
  assert.deepEqual(checkFigures('Fresko ya tiene 4 locales abiertos en Bogotá.', [locales]).map((i) => i.code), ['unsourced_figure']);
  assert.deepEqual(checkFigures('Te mando 4 ideas para Fresko.', [locales]), []);
  assert.deepEqual(checkFigures('Te propongo 4 videos para Fresko.', [locales]), []);
});

function fakeInput(over: Partial<GenerationInput> = {}): GenerationInput {
  return {
    lang: 'es', stepType: 'email', dayOffset: 0, guidance: null,
    angle: { key: 'x', label: 'x', goal: 'x', allowed: [], forbidden: [], proof: null, proofSources: ['creator_baseline', 'creator_profile', 'signal'] },
    creator: { name: 'Laura Méndez', handle: 'laura', niche: 'cocina', bio: null },
    company: { name: 'Fresko Market', industry: 'alimentos', city: 'Bogotá', country: 'CO' },
    contact: { fullName: 'Sofía Cárdenas', roleTitle: null },
    signal: { headline: '6 anuncios activos en Meta desde el 12 ago · alimentos', source: null, detectedAt: null },
    brief: null, claims: [...CLAIMS, ADS], previousTouches: [], avoid: [], attempt: 1, hint: null, maxChars: null,
    ...over,
  };
}

test('el redactor falso no copia una señal con cifras: la dice con su marca o no la dice', async () => {
  const gen = createFakeGenerator();
  const base = fakeInput();
  const con = await gen.generate(base);
  assert.match(con.body, /6 \[claim:signal:s1:active_ads\] anuncios activos/);
  assert.ok(!con.body.includes('· alimentos') && !con.body.includes('('), con.body);
  const pf = preflight({ stepType: 'email', subject: con.subject, body: con.body, claims: base.claims, allowedSources: base.angle!.proofSources, firstTouch: true });
  assert.deepEqual(pf.issues, []);
  // Si el ángulo no deja citar la señal, la señal con cifras no entra.
  const sin = await gen.generate(fakeInput({ angle: { ...base.angle!, proofSources: ['creator_baseline', 'creator_profile'] } }));
  assert.ok(!/anuncios|\b6\b/.test(stripClaimMarkers(sin.body)), sin.body);
  // Una señal sin cifras (más allá de su fecha) sí se cita, y sin paréntesis.
  const cafe = await gen.generate(fakeInput({
    company: { ...base.company, name: 'Café Alma' }, signal: { headline: 'Lanzó cold brew en botella el 22 jul', source: null, detectedAt: null },
  }));
  assert.match(cafe.body, /lanzó cold brew en botella el 22 jul/);
  assert.ok(!cafe.body.includes('('), cafe.body);
});

test('el redactor falso cita por prioridad: la campaña con esta marca, luego la mediana de su red principal', async () => {
  const gen = createFakeGenerator();
  const youtube: SalesClaim = {
    id: 'audience:youtube:gender:f', source: 'creator_profile', label: 'Seguidores mujeres en YouTube', value: 0.58, unit: 'share',
    display: '58 %', ref: { table: 'audience_breakdown', id: 'y1' },
  };
  const ytViews: SalesClaim = { ...CLAIMS[0]!, id: 'baseline:youtube:median_views', label: 'Mediana de views en YouTube a 7 días', value: 8000, display: '8.000' };
  const campana: SalesClaim = {
    id: 'campaign:c1:views', source: 'campaign_result', label: 'Views de la campaña con Café Alma', value: 412000, unit: 'count',
    display: '412.000', ref: { table: 'campaign_result', id: 'c1' }, entities: ['Café Alma'],
  };
  const angle = { key: 'x', label: 'x', goal: 'x', allowed: [], forbidden: [], proof: null, proofSources: ['creator_baseline', 'creator_profile', 'campaign_result'] as const };
  const claims = [youtube, ytViews, ...CLAIMS, campana];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const fresko = await gen.generate(fakeInput({ angle: { ...angle, proofSources: [...angle.proofSources] }, claims, signal: null, attempt }));
    assert.match(fresko.body, /(Mis videos de TikTok tienen una mediana de|En TikTok, un video mío típico llega a) 115\.446 \[claim:baseline:tiktok:median_views\] views/, fresko.body);
    const alma = await gen.generate(fakeInput({
      angle: { ...angle, proofSources: [...angle.proofSources] }, claims, signal: null, attempt, company: { name: 'Café Alma', industry: 'alimentos', city: 'Bogotá', country: 'CO' },
    }));
    // Ronda 5: ya trabajaron juntos, así que abre con esa relación y cita la campaña como «esa campaña».
    assert.match(alma.body, /(Después de la campaña que hicimos juntos con|Sigo con buen recuerdo de nuestra campaña con) Café Alma/, alma.body);
    assert.match(alma.body, /Esa campaña sumó 412\.000 \[claim:campaign:c1:views\] views\./, alma.body);
    assert.doesNotMatch(alma.body, /Sigo lo que hace|hay algo que quiero proponerte/, 'no es un correo en frío');
    assert.ok(alma.body.split('Café Alma').length - 1 <= 2, `la marca, dos veces como mucho: ${alma.body}`);
    assert.ok(fresko.body.split(fakeInput().company.name).length - 1 <= 2, `la marca, dos veces como mucho: ${fresko.body}`);
  }
});

// ---------------------------------------------------------------------
// Ronda 5
// ---------------------------------------------------------------------

test('ronda 5: el redondeo solo vale hacia abajo o a la precisión escrita: «115 mil» pasa por 115.446, «120 mil» no', () => {
  const mediana = CLAIMS[0]!;
  const pasa = (t: string, c: SalesClaim = mediana) => figureMatchesClaim(findFigures(t)[0]!, c);
  assert.equal(pasa('115 mil'), true);
  assert.equal(pasa('110 mil'), true, 'hacia abajo, dentro del 5 %');
  assert.equal(pasa('115.446'), true);
  assert.equal(pasa('120 mil'), false, 'redondear hacia arriba infla la cifra');
  assert.equal(pasa('120.000'), false);
  assert.equal(pasa('0,12 millones'), true, 'escrito a decenas de miles, 0,12 es el redondeo de 0,115');
  assert.equal(pasa('0,13 millones'), false);
  // El redondeo a la precisión con que se escribió sí vale, aunque suba: es lo que da Intl.
  const share: SalesClaim = { ...CLAIMS[1]!, value: 0.576, display: '58 %' };
  assert.equal(pasa('58 %', share), true);
  assert.equal(pasa('57,6 %', share), true);
  assert.equal(pasa('60 %', share), false);
  const multiple: SalesClaim = { ...CLAIMS[2]!, value: 6.66, display: '6,7×' };
  assert.equal(pasa('6,7×', multiple), true);
  assert.equal(pasa('x3', { ...multiple, value: 2.96, display: '3×' }), true, 'el display de Intl pasa');
  assert.equal(pasa('x3', { ...multiple, value: 3.4, display: '3,4×' }), false, 'redondeo a la unidad, pero un 12 % lejos');
  const millones: SalesClaim = { ...mediana, value: 1_180_000, display: '1.180.000' };
  assert.equal(pasa('1,2 millones', millones), true);
  assert.equal(pasa('1,3 millones', millones), false);
  // En el pre-vuelo: la cifra inflada con su marca no coincide con su origen.
  assert.deepEqual(checkFigures('Mi mediana es de 120 mil [claim:baseline:tiktok:median_views] views.', CLAIMS).map((i) => i.code), ['claim_mismatch']);
  assert.deepEqual(checkFigures('Mi mediana es de 115 mil [claim:baseline:tiktok:median_views] views.', CLAIMS), []);
});

test('ronda 5: «gané 3 premios» y «mi tasa de interacción es del 12» son cifras sin origen', () => {
  for (const [texto, raw] of [
    ['Este año gané 3 premios de contenido.', '3'],
    ['Tengo 2 reconocimientos de la industria.', '2'],
    ['I won 4 awards last year.', '4'],
  ] as const) {
    assert.deepEqual(checkFigures(texto, CLAIMS).map((i) => [i.code, i.detail]), [['unsourced_figure', raw]], texto);
  }
  for (const [texto, valor] of [
    ['Mi tasa de interacción es del 12, muy por encima del promedio.', 0.12],
    ['My engagement rate of 9 beats the average.', 0.09],
    ['La interacción mediana: 7 en mis últimos reels.', 0.07],
  ] as const) {
    const hits = findFigures(texto);
    assert.deepEqual(hits.map((h) => [h.kind, h.values[0]]), [['percent', valor]], texto);
    assert.equal(checkFigures(texto, CLAIMS)[0]?.code, 'unsourced_figure', texto);
  }
  // Con su origen, pasa: el 12 detrás de «tasa de interacción» es un 12 %.
  const tasa: SalesClaim = { ...CLAIMS[1]!, id: 'baseline:tiktok:median_engagement', value: 0.12, display: '12 %' };
  assert.deepEqual(checkFigures('Mi tasa de interacción es del 12 [claim:baseline:tiktok:median_engagement].', [tasa]), []);
  // Un número pequeño que no es un resultado sigue sin serlo.
  assert.deepEqual(checkFigures('Te mando 3 ideas de video para el lanzamiento.', CLAIMS), []);
});

test('ronda 5: el porcentaje de un claim se escribe con la regla de la app («58 %», con espacio), en cualquier locale', () => {
  for (const locale of ['es-CO', 'es-MX', 'en-US', 'es']) {
    assert.equal(formatClaimValue(0.576, 'share', locale), formatShare(0.576, 0, locale), locale);
    assert.match(formatClaimValue(0.576, 'share', locale), /^58 %$/, locale);
  }
  assert.equal(formatClaimValue(0.053, 'share', 'es-CO'), '5,3 %');
  assert.equal(formatClaimValue(0.053, 'share', 'en-US'), '5.3 %');
});

test('ronda 5: lo que escribe la IA guarda a la persona como variable: si cambia «Para», cambia el saludo', () => {
  const values = templateValuesFrom({ contact: { fullName: 'Camilo Herrera', roleTitle: null }, creator: { senderName: 'Laura Méndez' } });
  const ia = 'Hola Camilo,\n\nCamilo Herrera me recomendó escribirte. Mi mediana es de 115.446 [claim:baseline:tiktok:median_views] views.\n\n¿Te cuento?\n\nLaura Méndez';
  const marked = templatizePeople(ia, values, ['Laura Méndez', 'Café Alma']);
  // Solo el saludo y la firma: el nombre en medio del texto se queda escrito (pulido r1).
  assert.equal(
    marked,
    'Hola {{first_name}},\n\nCamilo Herrera me recomendó escribirte. Mi mediana es de 115.446 [claim:baseline:tiktok:median_views] views.\n\n¿Te cuento?\n\n{{sender_name}}',
  );
  // Rellenado con la misma persona, dice lo mismo; con otra, saluda a la otra.
  assert.equal(renderTemplate(marked, values), ia);
  const valentina = templateValuesFrom({ contact: { fullName: 'Valentina Ortiz', roleTitle: null }, creator: { senderName: 'Laura Méndez' } });
  assert.match(renderTemplate(marked, valentina)!, /^Hola Valentina,/);
  // Solo palabras enteras y con su grafía: «Camilonga» o «camilo» no son la persona.
  assert.equal(templatizeKnownValues('Camilonga y camilo', values, PERSON_VARIABLES), 'Camilonga y camilo');
  // Una persona con un solo nombre: first_name, no full_name.
  const solo = templateValuesFrom({ contact: { fullName: 'Camilo', roleTitle: null } });
  assert.equal(templatizePeople('Hola Camilo,', solo), 'Hola {{first_name}},');
});

test('pulido r1: un nombre que también es de la creadora o de la marca no se vuelve variable', () => {
  // La creadora es Laura Méndez y la contacto de Granos del Valle es Laura Quintero.
  const lauras = templateValuesFrom({ contact: { fullName: 'Laura Quintero', roleTitle: null }, creator: { senderName: 'Laura Méndez' } });
  const ia = 'Hola Laura,\n\nSoy Laura, hago recetas fáciles y vi lo nuevo de Granos del Valle.\n\n¿Te cuento una idea?\n\nLaura Méndez';
  const marked = templatizePeople(ia, lauras, ['Laura Méndez', 'Granos del Valle']);
  assert.ok(marked.includes('Soy Laura,'), marked);
  assert.ok(!marked.includes('{{first_name}}'), marked);
  assert.ok(marked.endsWith('{{sender_name}}'), marked);
  // Con otra persona en «Para», la creadora sigue siendo Laura.
  const andrea = templateValuesFrom({ contact: { fullName: 'Andrea Ruiz', roleTitle: null }, creator: { senderName: 'Laura Méndez' } });
  assert.ok(renderTemplate(marked, andrea)!.includes('Soy Laura,'));
  // Una contacto que se llama Alma, en Café Alma: la marca no se toca.
  const alma = templateValuesFrom({ contact: { fullName: 'Alma Rojas', roleTitle: null }, creator: { senderName: 'Laura Méndez' } });
  const cafe = templatizePeople('Hola Alma,\n\nMe encanta el cold brew de Café Alma.\n\nLaura Méndez', alma, ['Laura Méndez', 'Café Alma']);
  assert.ok(cafe.includes('Café Alma'), cafe);
  assert.ok(cafe.startsWith('Hola Alma,'), cafe);
  // El nombre completo sí es de la persona: en el saludo se vuelve variable.
  assert.equal(templatizePeople('Hola Alma Rojas,\n\nTexto.', alma, ['Café Alma']), 'Hola {{full_name}},\n\nTexto.');
});
