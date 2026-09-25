/**
 * VEN-13 · el hilo de correo, la guía de un paso que cambia de tipo y
 * las notas guardadas de una propuesta: las tres reglas que comparten el
 * recomendador y la línea de tiempo editable. Sin base ni red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThread } from '../src/outreach/thread.ts';
import {
  composeGuidance, guidanceAfterRetype, guidanceIsStale, recommendSequence, refineGuidance, type GuidanceRequest,
  type RecommendTemplate, type RecommendTemplateStep,
} from '../src/outreach/recomendar.ts';
import { GUIDANCE_PHRASES } from '../src/outreach/guidance-phrases.ts';
import { parseProposalNote, parseSequenceProposal } from '../src/outreach/proposal-notes.ts';

const s = (stepType: string, channel: string, angleKey: string | null = null) => ({ stepType, channel, angleKey });
const RESPONDE = /^Responde en el mismo hilo/;

test('normalizeThread: el primer correo abre el hilo y los siguientes responden en él', () => {
  // La colaboración con su primer correo bajado al tercer puesto: la respuesta queda primera.
  const tipos = normalizeThread([
    s('linkedin_message', 'linkedin', 'prueba_desempeno'),
    s('email_reply', 'email', 'concepto_creativo'),
    s('email', 'email', 'encaje_audiencia'),
    s('email', 'email', 'sintesis'),
  ]);
  assert.deepEqual(tipos, ['linkedin_message', 'email', 'email_reply', 'email']);
});

test('normalizeThread: el cierre que ya es correo nuevo se queda nuevo; el que es respuesta, respuesta', () => {
  assert.deepEqual(normalizeThread([s('email', 'email', 'encaje_audiencia'), s('email_reply', 'email', 'sintesis')]), ['email', 'email_reply']);
  assert.deepEqual(normalizeThread([s('email', 'email', 'encaje_audiencia'), s('email', 'email', 'sintesis')]), ['email', 'email']);
});

test('normalizeThread: lo que no es correo no cambia, y una tarea a mano sobre el correo tampoco', () => {
  const pasos = [s('manual_task', 'email'), s('linkedin_like', 'linkedin'), s('email_reply', 'email', 'presencia')];
  assert.deepEqual(normalizeThread(pasos), ['manual_task', 'linkedin_like', 'email']);
});

test('normalizeThread: el correo nuevo que la persona acaba de elegir se respeta en ese cambio', () => {
  const pasos = [s('email', 'email', 'encaje_audiencia'), s('email', 'email', 'concepto_creativo')];
  assert.deepEqual(normalizeThread(pasos), ['email', 'email_reply']);
  assert.deepEqual(normalizeThread(pasos, { keepNewThread: (i) => i === 1 }), ['email', 'email']);
});

const ctx = { signalKind: 'collab' as const, requiresDisclosure: false };

test('guidanceAfterRetype: la guía de la plantilla, de las reglas o del modelo se recompone para el tipo nuevo', () => {
  for (const source of ['template', 'rules', 'llm'] as const) {
    const r = guidanceAfterRetype(
      { guidance: 'Responde en el mismo hilo con una idea de video.', source, writtenFor: 'email_reply', angleKey: 'concepto_creativo' },
      'email',
      ctx,
    );
    assert.equal(r.guidance, composeGuidance('concepto_creativo', 'email', 'collab'));
    assert.doesNotMatch(r.guidance!, RESPONDE);
    assert.deepEqual([r.source, r.writtenFor], ['rules', 'email']);
    assert.equal(guidanceIsStale(r, 'email'), false);
  }
});

test('guidanceAfterRetype: la guía que escribió la persona se queda, marcada para revisarla', () => {
  const mia = { guidance: 'Mi guía para el correo, con mis palabras.', source: 'person' as const, writtenFor: 'email', angleKey: 'presencia' };
  const r = guidanceAfterRetype(mia, 'linkedin_message', ctx);
  assert.deepEqual(r, { guidance: mia.guidance, source: 'person', writtenFor: 'email' });
  assert.equal(guidanceIsStale(r, 'linkedin_message'), true);
  // Una fila anterior a 0062 (sin fuente) tampoco se pisa.
  assert.equal(guidanceAfterRetype({ ...mia, source: null }, 'linkedin_message', ctx).guidance, mia.guidance);
  // Sin cambio de tipo, nada cambia.
  assert.deepEqual(guidanceAfterRetype({ ...mia, source: 'template' }, 'email', ctx), { guidance: mia.guidance, source: 'template', writtenFor: 'email' });
});

test('guidanceAfterRetype: el cierre recompuesto conserva la divulgación del brief', () => {
  const r = guidanceAfterRetype(
    { guidance: 'Resume y cierra.', source: 'template', writtenFor: 'email', angleKey: 'sintesis' },
    'email_reply',
    { signalKind: 'launch', requiresDisclosure: true },
  );
  assert.ok(r.guidance!.endsWith(GUIDANCE_PHRASES.es.disclosure));
});

const paso = (day: number, type: string, channel: string, angle: string): RecommendTemplateStep => ({
  day_offset: day, order_in_day: 0, step_type: type, channel, angle_key: angle, scheduled_time: '09:30',
  generate_with_ai: true, requires_asset: null, guidance_es: `Guía de la plantilla para ${angle} el día ${day}.`,
});
const COLABORACION: RecommendTemplate = {
  slug: 'colaboracion-de-un-competidor', nameEs: 'Colaboración de un competidor', signalKind: 'collab', nicheSlug: null,
  steps: [
    paso(0, 'email', 'email', 'encaje_audiencia'), paso(3, 'linkedin_message', 'linkedin', 'prueba_desempeno'),
    paso(6, 'email_reply', 'email', 'concepto_creativo'), paso(9, 'email', 'email', 'sintesis'),
  ],
};
const entrada = {
  signalKind: 'collab' as const, nicheSlugs: [], channels: { email: 'connected', linkedin: 'connected', instagram_dm: 'missing' } as const,
  allowedChannels: ['email', 'linkedin'], contact: { hasEmail: true, hasLinkedin: true, hasInstagram: false }, requiresDisclosure: false,
  templates: [COLABORACION], policy: { maxTouchesPerCompany: 10, minDaysBetweenTouches: 0 },
};

test('la propuesta marca quién escribió cada guía: la plantilla, las reglas o el modelo', async () => {
  const p = recommendSequence(entrada);
  assert.deepEqual(p.steps.map((x) => x.guidanceSource), ['template', 'template', 'template', 'template']);
  // Sin LinkedIn, el directo pasa al correo: su guía es de reglas.
  const sinLinkedin = recommendSequence({ ...entrada, contact: { hasEmail: true, hasLinkedin: false, hasInstagram: false } });
  assert.equal(sinLinkedin.steps[1]!.guidanceSource, 'rules');
  assert.equal(sinLinkedin.steps[1]!.stepType, 'email_reply');

  let pedido: GuidanceRequest | null = null;
  const r = await refineGuidance(
    p,
    { signalHeadline: null, companyName: null, briefTitle: null, briefNotes: null, requiresDisclosure: false, angles: {}, locale: 'es' },
    async (req) => {
      pedido = req;
      return { steps: [{ index: 0, guidance: 'Abre con quién te ve y por qué compra su categoría.' }], usage: { model: 'm', inputTokens: 1, outputTokens: 1 } };
    },
  );
  assert.deepEqual(r.proposal.steps.map((x) => x.guidanceSource), ['llm', 'template', 'template', 'template']);
  // El redactor recibe el idioma en que escribir: el mismo de la guía compuesta.
  assert.equal(pedido!.locale, 'es');
});

test('las notas guardadas se leen con su esquema: la que no tiene su forma se descarta, las demás pasan', () => {
  assert.deepEqual(parseProposalNote({ code: 'contact_busy', sequenceName: 'Marca con campaña activa' }), {
    code: 'contact_busy', sequenceName: 'Marca con campaña activa',
  });
  assert.equal(parseProposalNote({ code: 'contact_busy' }), null);
  assert.equal(parseProposalNote({ code: 'rerouted', step: 1.5, from: 'a', to: 'b', manual: false, reason: 'channel_not_allowed' }), null);
  assert.equal(parseProposalNote({ code: 'inventada' }), null);
  assert.equal(parseProposalNote('no_contact'), null);

  const p = parseSequenceProposal({
    version: 1, templateSlug: 'x', signalKind: 'launch', guidance: 'otro', guidanceWhyRules: 'rara', contactId: 7,
    notes: [{ code: 'no_contact' }, { code: 'fitted_to_policy', softened: 'no' }, { code: 'no_creator' }],
  });
  assert.deepEqual(p, {
    version: 1, templateSlug: 'x', signalKind: 'launch', notes: [{ code: 'no_contact' }, { code: 'no_creator' }], guidance: 'rules',
    guidanceWhyRules: null, model: null, contactId: null, dealId: null, proposedAt: '',
  });
  assert.equal(parseSequenceProposal({ version: 2, templateSlug: 'x', signalKind: 'launch' }), null);
  assert.equal(parseSequenceProposal({ version: 1, templateSlug: 'x', signalKind: 'otra' }), null);
  assert.equal(parseSequenceProposal(null), null);
});
