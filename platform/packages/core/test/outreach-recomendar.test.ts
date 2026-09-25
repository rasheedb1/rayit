/**
 * VEN-13 · el recomendador de cadencia, sin base ni red.
 *
 * Las plantillas del fixture son las de 0037 («Marca con campaña
 * activa») y 0062 (cocina), copiadas con sus mismos pasos: la prueba
 * contra la base (packages/db/test/cadencias.test.ts) lee las de verdad.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseTemplate, composeGuidance, DISCLOSURE_GUIDANCE, guidanceProblem, primaryChannelOf, recommendSequence, RecommendError, refineGuidance,
  signalKindOfSource, type GuidanceWriter, type RecommendInput, type RecommendTemplate, type RecommendTemplateStep,
} from '../src/outreach/recomendar.ts';
import { GUIDANCE_PHRASES, guidanceLocale } from '../src/outreach/guidance-phrases.ts';
import { llmCostUsd, UnknownModelPriceError } from '../src/outreach/llm-cost.ts';
import { checkSequenceAgainstPolicy } from '../src/outreach/sequence-policy.ts';

const paso = (
  day: number, type: string, channel: string, angle: string, asset: 'media_kit' | 'quote' | null = null,
): RecommendTemplateStep => ({
  day_offset: day, order_in_day: 0, step_type: type, channel, angle_key: angle, scheduled_time: '09:30',
  generate_with_ai: true, requires_asset: asset, guidance_es: `Guía de la plantilla para ${angle} el día ${day}.`,
});

const CAMPANA: RecommendTemplate = {
  slug: 'marca-con-campana-activa', nameEs: 'Marca con campaña activa', signalKind: 'active_campaign', nicheSlug: null,
  steps: [
    paso(0, 'linkedin_comment', 'linkedin', 'presencia'),
    paso(1, 'email', 'email', 'encaje_audiencia'),
    paso(3, 'linkedin_message', 'linkedin', 'prueba_desempeno'),
    paso(5, 'email_reply', 'email', 'concepto_creativo'),
    paso(7, 'linkedin_message', 'linkedin', 'prueba_social'),
    paso(9, 'email', 'email', 'sintesis', 'media_kit'),
  ],
};
const COCINA: RecommendTemplate = {
  ...CAMPANA, slug: 'cocina-campana-activa', nameEs: 'Cocina · marca con campaña activa', nicheSlug: 'cocina',
  steps: [paso(0, 'instagram_comment', 'instagram_dm', 'presencia'), ...CAMPANA.steps.slice(1)],
};
const MANUAL: RecommendTemplate = {
  slug: 'senal-manual', nameEs: 'Marca elegida a mano', signalKind: 'manual', nicheSlug: null,
  steps: [paso(0, 'email', 'email', 'encaje_audiencia'), paso(3, 'email', 'email', 'sintesis')],
};
const BELLEZA: RecommendTemplate = { ...CAMPANA, slug: 'belleza-lanzamiento', signalKind: 'launch', nicheSlug: 'belleza' };

const TODO_CONECTADO = { email: 'connected', linkedin: 'connected', instagram_dm: 'missing' } as const;
/** Una política que no recorta nada: las pruebas de canal ven la plantilla tal cual. */
const SIN_TOPE = { maxTouchesPerCompany: 10, minDaysBetweenTouches: 0 };
/** La política por defecto de outbound_policy (0007) y la del seed. */
const POR_DEFECTO = { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3 };

const politicaDe = (p: { steps: ReadonlyArray<{ stepType: string; dayOffset: number; orderInDay: number }> }, pol = POR_DEFECTO) =>
  checkSequenceAgainstPolicy(p.steps.map((s, i) => ({ id: String(i + 1), ...s })), pol);

function entrada(over: Partial<RecommendInput> = {}): RecommendInput {
  return {
    signalKind: 'active_campaign',
    nicheSlugs: [],
    channels: TODO_CONECTADO,
    allowedChannels: ['email', 'linkedin'],
    contact: { hasEmail: true, hasLinkedin: true, hasInstagram: false },
    requiresDisclosure: false,
    templates: [CAMPANA, COCINA, MANUAL, BELLEZA],
    policy: SIN_TOPE,
    ...over,
  };
}

test('campaña activa: seis pasos con día, canal, ángulo y guía, tal como la plantilla', () => {
  const p = recommendSequence(entrada());
  assert.equal(p.templateSlug, 'marca-con-campana-activa');
  assert.equal(p.steps.length, 6);
  assert.deepEqual(p.steps.map((s) => [s.dayOffset, s.stepType, s.angleKey]), [
    [0, 'linkedin_comment', 'presencia'], [1, 'email', 'encaje_audiencia'], [3, 'linkedin_message', 'prueba_desempeno'],
    [5, 'email_reply', 'concepto_creativo'], [7, 'linkedin_message', 'prueba_social'], [9, 'email', 'sintesis'],
  ]);
  for (const s of p.steps) assert.ok(s.guidanceEs.length > 20 && s.changedFrom === null);
  assert.deepEqual(p.notes, [{ code: 'template', slug: 'marca-con-campana-activa', match: 'signal' }]);
  assert.equal(p.primaryChannel, 'email');
});

test('el canal principal cuenta solo los pasos que le escriben a la persona, no los gestos públicos', () => {
  // Dos gestos en LinkedIn (un comentario y una reacción) y un correo: ningún mensaje sale por LinkedIn.
  assert.equal(
    primaryChannelOf([
      { channel: 'linkedin', stepType: 'linkedin_comment' }, { channel: 'linkedin', stepType: 'linkedin_like' },
      { channel: 'email', stepType: 'email' },
    ]),
    'email',
  );
  assert.equal(
    primaryChannelOf([{ channel: 'linkedin', stepType: 'linkedin_message' }, { channel: 'email', stepType: 'manual_task' }]),
    'linkedin',
  );
});

test('lo que no se despacha no se redacta: el comentario y la reacción públicos salen sin generación automática', () => {
  const p = recommendSequence(entrada());
  // La plantilla marca generate_with_ai en todos; el comentario del día 0 lo hace una persona.
  assert.deepEqual(p.steps.map((s) => s.generateWithAi), [false, true, true, true, true, true]);
});

test('la propuesta cambia si el contacto no tiene LinkedIn: los directos pasan al hilo del correo', () => {
  const con = recommendSequence(entrada());
  const sin = recommendSequence(entrada({ contact: { hasEmail: true, hasLinkedin: false, hasInstagram: false } }));
  assert.equal(sin.steps.length, 6);
  assert.notDeepEqual(sin.steps, con.steps);
  // El comentario público no le escribe a la persona: sigue en LinkedIn.
  assert.equal(sin.steps[0]!.stepType, 'linkedin_comment');
  assert.deepEqual([sin.steps[2]!.stepType, sin.steps[4]!.stepType], ['email_reply', 'email_reply']);
  assert.ok(sin.steps.every((s) => s.stepType !== 'linkedin_message'));
  assert.deepEqual(sin.steps[2]!.changedFrom, { stepType: 'linkedin_message', channel: 'linkedin' });
  assert.match(sin.steps[2]!.guidanceEs, /^Responde en el mismo hilo/);
  assert.deepEqual(
    sin.notes.filter((n) => n.code === 'rerouted'),
    [
      { code: 'rerouted', step: 3, from: 'linkedin', to: 'email', manual: false, reason: 'contact_has_no_address' },
      { code: 'rerouted', step: 5, from: 'linkedin', to: 'email', manual: false, reason: 'contact_has_no_address' },
    ],
  );
});

test('con la política por defecto (4 mensajes, 3 días) la propuesta nace cumpliéndola y conserva la síntesis', () => {
  const p = recommendSequence(entrada({ policy: POR_DEFECTO }));
  assert.equal(p.steps.length, 6, 'seis pasos: la prueba social pasa a gesto, no se pierde el día');
  assert.deepEqual(p.steps.map((s) => [s.dayOffset, s.stepType, s.angleKey]), [
    [0, 'linkedin_comment', 'presencia'], [1, 'email', 'encaje_audiencia'], [4, 'linkedin_message', 'prueba_desempeno'],
    [7, 'email_reply', 'concepto_creativo'], [9, 'linkedin_like', 'presencia'], [11, 'email', 'sintesis'],
  ]);
  assert.deepEqual(politicaDe(p), { overCap: [], closerThanGap: [] });
  const cierre = p.steps.at(-1)!;
  assert.equal(cierre.requiresAsset, 'media_kit');
  assert.equal(cierre.changedFrom, null, 'la síntesis no se toca');
  assert.deepEqual(p.steps[4]!.changedFrom, { stepType: 'linkedin_message', channel: 'linkedin' });
  assert.equal(p.steps[4]!.generateWithAi, false);
  // Es una reacción: la guía no pide frases ni comentar (eso es otro paso).
  assert.match(p.steps[4]!.guidanceEs, /^Hazlo a mano: reacciona a su última publicación/);
  assert.doesNotMatch(p.steps[4]!.guidanceEs, /frases|[Cc]omenta /);
  assert.deepEqual(p.notes.find((n) => n.code === 'fitted_to_policy'), {
    code: 'fitted_to_policy', softened: ['prueba_social'], dropped: [], shiftedDays: 2, maxTouches: 4, minDays: 3,
  });
});

test('la política también ajusta la propuesta sin LinkedIn, y sus notas hablan de los pasos que quedan', () => {
  const p = recommendSequence(entrada({ policy: POR_DEFECTO, contact: { hasEmail: true, hasLinkedin: false, hasInstagram: false } }));
  assert.deepEqual(politicaDe(p), { overCap: [], closerThanGap: [] });
  assert.deepEqual(p.steps.map((s) => s.stepType), [
    'linkedin_comment', 'email', 'email_reply', 'email_reply', 'linkedin_like', 'email',
  ]);
  // La prueba social pasó al hilo del correo y luego a gesto: su nota de canal ya no se dice.
  assert.deepEqual(p.notes.filter((n) => n.code === 'rerouted').map((n) => 'step' in n && n.step), [3]);
  assert.notDeepEqual(p.steps, recommendSequence(entrada({ policy: POR_DEFECTO })).steps);
});

test('un tope más bajo sacrifica en orden (prueba social, luego concepto); sin red para el gesto, el paso se quita', () => {
  const tres = recommendSequence(entrada({ policy: { maxTouchesPerCompany: 3, minDaysBetweenTouches: 2 } }));
  assert.deepEqual(politicaDe(tres, { maxTouchesPerCompany: 3, minDaysBetweenTouches: 2 }), { overCap: [], closerThanGap: [] });
  const nota = tres.notes.find((n) => n.code === 'fitted_to_policy');
  assert.deepEqual(nota && 'softened' in nota && nota.softened, ['prueba_social', 'concepto_creativo']);
  assert.equal(tres.steps.at(-1)!.angleKey, 'sintesis');

  // Solo correo: nada donde reaccionar. El concepto se va, y la respuesta que abría el hilo no queda sin hilo.
  const soloCorreo = recommendSequence(
    entrada({
      policy: { maxTouchesPerCompany: 2, minDaysBetweenTouches: 3 },
      channels: { email: 'connected', linkedin: 'missing', instagram_dm: 'missing' },
    }),
  );
  assert.deepEqual(politicaDe(soloCorreo, { maxTouchesPerCompany: 2, minDaysBetweenTouches: 3 }), { overCap: [], closerThanGap: [] });
  assert.deepEqual(soloCorreo.steps.filter((s) => s.stepType !== 'manual_task').map((s) => [s.stepType, s.angleKey]), [
    ['email', 'encaje_audiencia'], ['email', 'sintesis'],
  ]);
  const fit = soloCorreo.notes.find((n) => n.code === 'fitted_to_policy');
  assert.ok(fit && 'dropped' in fit && fit.dropped.length === 3);
  assert.ok(soloCorreo.steps.every((s) => s.dayOffset <= 60));
});

test('una separación que no cabe en 60 días sacrifica mensajes antes de pasarse del último día', () => {
  const p = recommendSequence(entrada({ policy: { maxTouchesPerCompany: 10, minDaysBetweenTouches: 25 } }));
  assert.ok(p.steps.every((s) => s.dayOffset <= 60));
  assert.deepEqual(politicaDe(p, { maxTouchesPerCompany: 10, minDaysBetweenTouches: 25 }), { overCap: [], closerThanGap: [] });
  assert.equal(p.steps.at(-1)!.angleKey, 'sintesis');
});

test('sin LinkedIn conectado ni Instagram permitido, el gesto público queda como tarea a mano', () => {
  const p = recommendSequence(entrada({ channels: { email: 'connected', linkedin: 'missing', instagram_dm: 'connected' } }));
  assert.equal(p.steps[0]!.stepType, 'manual_task');
  assert.match(p.steps[0]!.guidanceEs, /^Hazlo a mano/);
  assert.ok(p.notes.some((n) => n.code === 'rerouted' && n.step === 1 && n.manual && n.reason === 'channel_not_connected'));
  // Instagram está conectado pero la política no lo deja (0045 lo apaga por defecto).
  assert.equal(p.steps[2]!.channel, 'email');
});

test('con Instagram permitido, los directos van por Instagram antes que por correo', () => {
  const p = recommendSequence(
    entrada({
      channels: { email: 'connected', linkedin: 'missing', instagram_dm: 'connected' },
      allowedChannels: ['email', 'linkedin', 'instagram_dm'],
      contact: { hasEmail: true, hasLinkedin: false, hasInstagram: true },
    }),
  );
  assert.deepEqual(p.steps.map((s) => s.stepType), [
    'instagram_comment', 'email', 'instagram_dm', 'email_reply', 'instagram_dm', 'email',
  ]);
});

test('el primer correo del hilo abre el hilo: sin correo, todo va por LinkedIn y nada es una respuesta', () => {
  const p = recommendSequence(entrada({ contact: { hasEmail: false, hasLinkedin: true, hasInstagram: false } }));
  assert.ok(p.steps.every((s) => s.channel === 'linkedin'));
  assert.equal(p.primaryChannel, 'linkedin');
  // Si el correo vuelve para un paso posterior, el primero que queda es `email`.
  const manual = recommendSequence(entrada({ signalKind: 'manual', contact: { hasEmail: true, hasLinkedin: true, hasInstagram: false } }));
  assert.equal(manual.steps[0]!.stepType, 'email');
});

test('nadie a quien escribir por ningún canal: el paso se queda y la nota lo dice', () => {
  const p = recommendSequence(entrada({ contact: { hasEmail: false, hasLinkedin: false, hasInstagram: true } }));
  assert.equal(p.steps.length, 6);
  assert.ok(p.notes.some((n) => n.code === 'unreachable' && n.step === 2));
});

test('el nicho del creador elige su plantilla, y la de otro nicho o de otra señal nunca', () => {
  assert.equal(chooseTemplate([CAMPANA, COCINA], 'active_campaign', ['cocina'])!.template.slug, 'cocina-campana-activa');
  assert.equal(chooseTemplate([CAMPANA, COCINA], 'active_campaign', ['cocina'])!.match, 'niche_and_signal');
  assert.equal(chooseTemplate([CAMPANA, COCINA], 'active_campaign', ['viajes'])!.template.slug, 'marca-con-campana-activa');
  assert.equal(chooseTemplate([CAMPANA, BELLEZA], 'launch', ['cocina']), null);
  const p = recommendSequence(entrada({ nicheSlugs: ['cocina'] }));
  assert.equal(p.templateSlug, 'cocina-campana-activa');
  // Su presencia es en Instagram; sin Instagram en la política, pasa a LinkedIn.
  assert.equal(p.steps[0]!.stepType, 'linkedin_comment');
  assert.ok(p.notes.some((n) => n.code === 'rerouted' && n.reason === 'channel_not_allowed'));
});

test('sin plantilla para la señal, error con código (la pantalla lo traduce)', () => {
  assert.throws(() => recommendSequence(entrada({ signalKind: 'season' })), (e) => e instanceof RecommendError && e.code === 'no_template');
});

test('la divulgación del brief va al cierre, una sola vez', () => {
  const p = recommendSequence(entrada({ requiresDisclosure: true }));
  const cierre = p.steps.find((s) => s.angleKey === 'sintesis')!;
  assert.ok(cierre.guidanceEs.endsWith(DISCLOSURE_GUIDANCE));
  assert.equal(p.steps.filter((s) => s.guidanceEs.includes(DISCLOSURE_GUIDANCE)).length, 1);
  assert.ok(p.notes.some((n) => n.code === 'disclosure'));
});

test('una cuenta por reconectar se planea igual y se avisa', () => {
  const p = recommendSequence(entrada({ channels: { email: 'connected', linkedin: 'down', instagram_dm: 'missing' } }));
  assert.equal(p.steps[2]!.channel, 'linkedin');
  assert.ok(p.notes.some((n) => n.code === 'channel_down' && n.channel === 'linkedin'));
});

test('composeGuidance: abre, prohíbe y cierra según el canal, y en una colaboración no nombra a nadie', () => {
  assert.equal(
    composeGuidance('encaje_audiencia', 'email', 'active_campaign'),
    'Abre con la coincidencia entre tu audiencia y su cliente, con una cifra de tu perfil. No menciones precio ni adjuntes el media kit. Cierra con una sola pregunta.',
  );
  assert.match(composeGuidance('concepto_creativo', 'linkedin_message', 'launch'), /^Mensaje corto con una idea de video concreta para su lanzamiento\./);
  assert.match(composeGuidance('prueba_social', 'email_reply', 'collab'), /No nombres la colaboración que viste/);
  assert.doesNotMatch(composeGuidance('sintesis', 'email', 'manual'), /pregunta/);
});

test('signalKindOfSource: anuncios, marketplace y vacantes son campaña activa; prensa, lanzamiento', () => {
  assert.deepEqual(
    ['ads', 'marketplace', 'jobs', 'press', 'season', 'collab', 'manual', null].map(signalKindOfSource),
    ['active_campaign', 'active_campaign', 'active_campaign', 'launch', 'season', 'collab', 'manual', 'manual'],
  );
});

test('refineGuidance: se queda con la guía del modelo que sirve y con la regla donde no', async () => {
  const base = recommendSequence(entrada({ requiresDisclosure: true }));
  const vistos: unknown[] = [];
  const writer: GuidanceWriter = async (req) => {
    vistos.push(req);
    return {
      steps: [
        { index: 0, guidance: 'Comenta la receta de su último reel con un detalle que solo vería alguien que cocina.' },
        { index: 1, guidance: 'Hola {{first_name}}, abre con tu audiencia.' },
        { index: 2, guidance: 'corto' },
        { index: 5, guidance: 'Cierra con el media kit, la cotización y una fecha para hablar la próxima semana.' },
      ],
      usage: { model: 'claude-sonnet-5', inputTokens: 900, outputTokens: 300 },
    };
  };
  const r = await refineGuidance(
    base,
    { signalHeadline: '6 anuncios activos', companyName: 'Fresko', briefTitle: null, briefNotes: null, requiresDisclosure: true, angles: {} },
    writer,
  );
  assert.equal(r.source, 'llm');
  assert.equal(r.keptRules, 4);
  assert.deepEqual(r.usage, { model: 'claude-sonnet-5', inputTokens: 900, outputTokens: 300 });
  assert.match(r.proposal.steps[0]!.guidanceEs, /^Comenta la receta/);
  assert.equal(r.proposal.steps[1]!.guidanceEs, base.steps[1]!.guidanceEs, 'con huecos, se queda la regla');
  assert.equal(r.proposal.steps[2]!.guidanceEs, base.steps[2]!.guidanceEs, 'demasiado corta, se queda la regla');
  assert.ok(r.proposal.steps[5]!.guidanceEs.endsWith(DISCLOSURE_GUIDANCE), 'la divulgación vuelve aunque el modelo la olvide');
  assert.deepEqual(r.proposal.steps.map((s) => s.channel), base.steps.map((s) => s.channel), 'los canales no cambian');
  // Al redactor no le llega nada de la persona: solo el paso, la señal y el brief.
  assert.doesNotMatch(JSON.stringify(vistos), /hasEmail|@/);
});

test('refineGuidance: si el redactor falla, todo queda con reglas y sin llamada que registrar', async () => {
  const base = recommendSequence(entrada());
  const r = await refineGuidance(
    base,
    { signalHeadline: null, companyName: null, briefTitle: null, briefNotes: null, requiresDisclosure: false, angles: {} },
    async () => {
      throw new Error('red caída');
    },
  );
  assert.deepEqual(r, { proposal: base, source: 'rules', usage: null, keptRules: 6, failed: true });
});

test('guidanceProblem y llmCostUsd', () => {
  assert.equal(guidanceProblem('Abre con la coincidencia de audiencias.'), null);
  assert.equal(guidanceProblem('x'.repeat(401)), 'too_long');
  assert.equal(guidanceProblem('Abre con [NOMBRE] y su producto.'), 'placeholders');
  assert.equal(llmCostUsd({ model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 500 }), '0.007000');
  assert.equal(llmCostUsd({ model: 'claude-haiku-4-5-20251001', inputTokens: 2_000_000, outputTokens: 0 }), '2.000000');
  assert.throws(() => llmCostUsd({ model: 'otro', inputTokens: 1, outputTokens: 1 }), UnknownModelPriceError);
});

test('las frases de la guía salen de una tabla por idioma; hoy, la española, y el texto no cambió', () => {
  assert.equal(guidanceLocale('es-CO'), 'es');
  assert.equal(guidanceLocale('es_MX'), 'es');
  // Sin tabla para ese idioma: español, como las plantillas.
  assert.equal(guidanceLocale('pt-BR'), 'es');
  assert.equal(guidanceLocale(null), 'es');
  assert.equal(DISCLOSURE_GUIDANCE, GUIDANCE_PHRASES.es.disclosure);
  // Una reacción no lleva texto: ni frases ni comentario (comentar es otro paso), y lo dice.
  assert.equal(
    composeGuidance('presencia', 'linkedin_like', 'active_campaign', 'es'),
    'Hazlo a mano: reacciona a su última publicación, mejor si habla de su campaña activa. No comentes ni escribas.',
  );
  assert.equal(composeGuidance('prueba_social', 'instagram_like', 'launch', 'es'), GUIDANCE_PHRASES.es.lead.reaction('su lanzamiento'));
  // La tarea a mano (un gesto sin red conectada) sí puede ser comentar: conserva su frase.
  assert.equal(
    composeGuidance('presencia', 'manual_task', 'active_campaign', 'es'),
    'Hazlo a mano: reacciona o comenta algo concreto de su último post, en una o dos frases. No vendas, no menciones tarifas ni pongas enlaces.',
  );
  assert.equal(
    composeGuidance('presencia', 'linkedin_comment', 'active_campaign', 'es'),
    'Comenta algo concreto de su último post, en una o dos frases. No vendas, no menciones tarifas ni pongas enlaces.',
  );
  assert.equal(
    composeGuidance('prueba_social', 'linkedin_message', 'season', 'es'),
    'Mensaje corto con el resultado medido de una campaña tuya con una marca del mismo sector. Solo campañas con resultado; no nombres a su competencia directa. Cierra con una sola pregunta.',
  );
  // Pasar el idioma del espacio no cambia nada en español: la misma propuesta que sin él.
  const conLocale = recommendSequence(entrada({ locale: guidanceLocale('es-CO'), contact: { hasEmail: true, hasLinkedin: false, hasInstagram: false } }));
  const sinLocale = recommendSequence(entrada({ contact: { hasEmail: true, hasLinkedin: false, hasInstagram: false } }));
  assert.deepEqual(conLocale, sinLocale);
});
