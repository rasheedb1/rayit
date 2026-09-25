/**
 * VEN-12 · el renderizador único, las afirmaciones trazables, las tres
 * compuertas y el pre-vuelo. Puro, sin base ni red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimsCitedIn, figureMatchesClaim, findClaimMarkers, findFigures, stripClaimMarkers, type SalesClaim,
} from '../src/outreach/claims.ts';
import {
  bodyFingerprint, idempotencyGate, jaccard, shingles, similarityGate, similarityThreshold, subjectGate, textSimilarity,
} from '../src/outreach/gates.ts';
import { checkFigures, preflight, questionCloses, shoutingIn } from '../src/outreach/preflight.ts';
import { renderTemplate, TEMPLATE_VARIABLES, templateValuesFrom, templateVariablesIn } from '../src/outreach/render.ts';

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
  assert.deepEqual(shoutingIn('Es GRATIS y YA'), ['GRATIS']);
  assert.equal(questionCloses('Idea.\n\n¿Te sirve?\n\nLaura'), true);
  assert.equal(questionCloses('¿Te sirve?\n\nUna idea larga que sigue después de la pregunta y no es una firma para nada.'), false);
  // Un comentario público no necesita pregunta y no lleva asunto.
  const comentario = preflight({ stepType: 'linkedin_comment', body: 'Qué buena la idea del empaque retornable para la ciudad.', claims: [], firstTouch: true });
  assert.equal(comentario.ok, true);
});
