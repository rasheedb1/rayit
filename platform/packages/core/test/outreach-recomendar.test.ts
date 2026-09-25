/**
 * VEN-13 · el recomendador de cadencia, sin base ni red.
 *
 * Las plantillas del fixture son las de 0037 («Marca con campaña
 * activa») y 0058 (cocina), copiadas con sus mismos pasos: la prueba
 * contra la base (packages/db/test/cadencias.test.ts) lee las de verdad.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseTemplate, composeGuidance, DISCLOSURE_GUIDANCE, guidanceProblem, recommendSequence, RecommendError, refineGuidance,
  signalKindOfSource, type GuidanceWriter, type RecommendInput, type RecommendTemplate, type RecommendTemplateStep,
} from '../src/outreach/recomendar.ts';
import { llmCostUsd, UnknownModelPriceError } from '../src/outreach/llm-cost.ts';

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

function entrada(over: Partial<RecommendInput> = {}): RecommendInput {
  return {
    signalKind: 'active_campaign',
    nicheSlugs: [],
    channels: TODO_CONECTADO,
    allowedChannels: ['email', 'linkedin'],
    contact: { hasEmail: true, hasLinkedin: true, hasInstagram: false },
    requiresDisclosure: false,
    templates: [CAMPANA, COCINA, MANUAL, BELLEZA],
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
