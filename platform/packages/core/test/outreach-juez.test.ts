/**
 * VEN-12 · el generador, el juez y la puerta de calidad completa, con
 * modelos falsos o guionizados. Sin red y sin llave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SalesClaim } from '../src/outreach/claims.ts';
import { createFakeGenerator, createFakeJudge } from '../src/outreach/fake.ts';
import { buildGenerationPrompt, loadPrompt, LlmMessageGenerator, type GenerationInput, type MessageGenerator } from '../src/outreach/generate.ts';
import { textSimilarity } from '../src/outreach/gates.ts';
import { DEFAULT_RUBRIC, LlmMessageJudge, weightedScore, type JudgeVerdict, type MessageJudge } from '../src/outreach/judge.ts';
import { llmCostUsd, temperatureFor, type LlmClient, type LlmRequest, type LlmResponse } from '../src/outreach/llm.ts';
import { runQualityGate, type LlmCallRecord, type QualityGateInput } from '../src/outreach/quality-gate.ts';

const CLAIMS: SalesClaim[] = [
  {
    id: 'baseline:tiktok:median_views', source: 'creator_baseline', label: 'Mediana de views en TikTok a 7 días', value: 115446,
    unit: 'count', display: '115.446', ref: { table: 'creator_baseline', id: 'b1' },
  },
  {
    id: 'audience:tiktok:age:25-34', source: 'creator_profile', label: 'Audiencia de 25 a 34 años en TikTok', value: 0.37,
    unit: 'share', display: '37 %', ref: { table: 'audience_breakdown', id: 'a1' },
  },
];

function generation(over: Partial<GenerationInput> = {}): Omit<GenerationInput, 'attempt' | 'hint'> {
  return {
    lang: 'es', stepType: 'email', dayOffset: 1, guidance: 'Abre con la coincidencia entre tu audiencia y su cliente.',
    angle: {
      key: 'encaje_audiencia', label: 'Encaje de audiencia', goal: 'Explicar quién ve los videos.', allowed: ['Demografía'],
      forbidden: ['Hablar de tarifas'], proof: 'Demografía', proofSources: ['creator_profile', 'creator_baseline'],
    },
    creator: { name: 'Laura Méndez', handle: 'laura.cocinafacil', niche: 'cocina', bio: 'Cocina fácil.' },
    company: { name: 'Café Alma', industry: 'alimentos', city: 'Bogotá', country: 'CO' },
    contact: { fullName: 'Valentina Ríos', roleTitle: 'Gerente de marca' },
    signal: { headline: 'Lanzó cold brew en botella el 22 jul', source: 'press_launches', detectedAt: new Date('2026-07-22T11:00:00Z') },
    brief: null, claims: CLAIMS, previousTouches: [], avoid: [], maxChars: null,
    ...over,
  };
}

function gateInput(over: Partial<QualityGateInput> = {}): QualityGateInput {
  return { generation: generation(), rubric: DEFAULT_RUBRIC, recentSent: [], firstTouch: true, requiresDisclosure: false, ...over };
}

function deps(generator: MessageGenerator, judge: MessageJudge, budget = 5) {
  const calls: LlmCallRecord[] = [];
  let left = budget;
  return {
    calls,
    deps: {
      generator, judge,
      remainingBudgetUsd: async () => left,
      recordLlmCall: async (c: LlmCallRecord) => {
        calls.push(c);
        left -= c.costUsd;
      },
    },
  };
}

/** Un LlmClient que responde lo que le toca, en orden, con tokens de verdad. */
function scriptedLlm(texts: string[], usage = { input: 1200, output: 150 }): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    name: 'guion',
    requests,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      requests.push(req);
      const text = texts[Math.min(requests.length - 1, texts.length - 1)]!;
      return { text, model: req.model, inputTokens: usage.input, outputTokens: usage.output, costUsd: llmCostUsd(req.model, usage.input, usage.output), stopReason: 'end_turn' };
    },
  };
}

test('los precios y la temperatura: sonnet-5 no recibe temperatura (la rechaza), haiku sí', () => {
  assert.equal(llmCostUsd('claude-sonnet-5', 1_000_000, 0), 2);
  assert.equal(llmCostUsd('claude-sonnet-5', 1200, 150), 0.0039);
  assert.equal(llmCostUsd('modelo-desconocido', 1000, 1000), 0);
  assert.equal(temperatureFor('claude-sonnet-5', 'generate'), undefined);
  assert.equal(temperatureFor('claude-haiku-4-5-20251001', 'classify'), 0);
});

test('el prompt del generador lleva el ángulo, los claims, la pista y SOLO los toques que recibe (los enviados)', () => {
  const sent = { stepType: 'email', channel: 'email', sentAt: new Date('2026-09-20T14:00:00Z'), subject: 'Una idea', body: 'Lo que sí salió.' };
  const { system, user } = buildGenerationPrompt(
    { ...generation({ previousTouches: [sent] }), attempt: 2, hint: 'shorter' },
    loadPrompt('generate'),
  );
  assert.ok(system.includes('[claim:ID]'));
  assert.ok(system.includes('entre 250 y 1200 caracteres'));
  assert.ok(user.includes('baseline:tiktok:median_views · Mediana de views en TikTok a 7 días · 115.446 · creator_baseline'));
  assert.ok(user.includes('Lo que sí salió.'));
  assert.ok(user.includes('Prohibido: Hablar de tarifas'));
  assert.ok(user.includes('Pista de esta versión (intento 2)'));
  const primero = buildGenerationPrompt({ ...generation(), attempt: 1, hint: null }, loadPrompt('generate')).user;
  assert.ok(primero.includes('(ninguno: este es el primero)'));
});

test('el generador sobre el modelo pide salida estructurada y devuelve el costo', async () => {
  const llm = scriptedLlm([JSON.stringify({ subject: 'Tu cold brew y mi audiencia', body: 'Hola [claim:x]' })]);
  const out = await new LlmMessageGenerator(llm).generate({ ...generation(), attempt: 1, hint: null });
  assert.equal(out.subject, 'Tu cold brew y mi audiencia');
  assert.equal(out.costUsd, 0.0039);
  assert.equal(llm.requests[0]!.model, 'claude-sonnet-5');
  assert.equal(llm.requests[0]!.purpose, 'generate');
  assert.equal(llm.requests[0]!.maxTokens, 900);
  assert.ok(llm.requests[0]!.jsonSchema);
});

test('el juez sobre el modelo: nota por dimensión, nota ponderada, riesgos filtrados, tokens y costo', async () => {
  const llm = scriptedLlm([
    JSON.stringify({ scores: { relevance: 9, quality: 8, structure: 8.5, voice: 7 }, risk_triggers: ['pressure', 'inventado'], regenerate_hint: null, note: 'Bien.' }),
  ]);
  const v = await new LlmMessageJudge(llm).judge({
    lang: 'es', stepType: 'email', dayOffset: 1, rubric: DEFAULT_RUBRIC, angleLabel: 'Encaje', angleGoal: null, signalHeadline: null,
    creator: { name: 'Laura', bio: null }, company: { name: 'Café Alma', industry: null }, previousTouches: [], subject: 'Asunto de prueba',
    body: 'Cuerpo', citedClaims: CLAIMS, requiresDisclosure: false,
  });
  assert.deepEqual(v.riskTriggers, ['pressure']);
  assert.equal(v.note, 'Bien.');
  assert.deepEqual([v.inputTokens, v.outputTokens, v.costUsd], [1200, 150, 0.0039]);
  assert.equal(weightedScore(v.scores, DEFAULT_RUBRIC.weights), 8.23);
  assert.ok(llm.requests[0]!.user.includes('Mediana de views en TikTok a 7 días: 115.446'));
});

test('con el generador y el juez falsos, un buen correo pasa al primer intento y todo queda registrado', async () => {
  const { calls, deps: d } = deps(createFakeGenerator(), createFakeJudge());
  const r = await runQualityGate(gateInput(), d);
  assert.equal(r.status, 'approved', JSON.stringify(r.attempts.map((a) => a.gates)));
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0]!.decision, 'pass');
  assert.ok((r.attempts[0]!.total ?? 0) >= 7.7);
  assert.deepEqual(calls.map((c) => c.purpose), ['generate', 'judge']);
  assert.ok(!r.chosen!.cleanBody.includes('[claim:'));
});

/** Un generador que primero inventa una cifra y después escribe bien. */
function generatorThatLiesFirst(): MessageGenerator {
  const fake = createFakeGenerator();
  return {
    name: 'mentiroso', model: 'guion',
    async generate(input) {
      const out = await fake.generate(input);
      if (input.attempt > 1) return out;
      return { ...out, body: out.body.replace('\n\n¿', ' Tengo 500.000 seguidores fieles.\n\n¿') };
    },
  };
}

function judgeWith(scores: JudgeVerdict['scores'], riskTriggers: JudgeVerdict['riskTriggers'] = []): MessageJudge {
  return {
    name: 'guion', model: 'claude-sonnet-5',
    async judge() {
      return { scores, riskTriggers, hint: null, note: 'Nota del guion.', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 100, costUsd: llmCostUsd('claude-sonnet-5', 1000, 100) };
    },
  };
}

test('una cifra sin claim no llega al juez: el intento se rechaza sin tokens y se regenera con «add_proof»', async () => {
  const { calls, deps: d } = deps(generatorThatLiesFirst(), createFakeJudge());
  const r = await runQualityGate(gateInput(), d);
  assert.equal(r.status, 'approved');
  assert.deepEqual(r.attempts.map((a) => a.decision), ['reject', 'pass']);
  assert.deepEqual(r.attempts[0]!.riskTriggers, ['unsourced_figure']);
  assert.equal(r.attempts[0]!.hint, 'add_proof');
  assert.equal(r.attempts[0]!.judge, null);
  assert.deepEqual(calls.map((c) => c.purpose), ['generate', 'generate', 'judge']);
});

test('entre el mínimo y el umbral se regenera hasta cinco veces y sale el mejor; por debajo del mínimo o con riesgo, a una persona', async () => {
  const media = await runQualityGate(gateInput(), deps(createFakeGenerator(), judgeWith({ relevance: 7, quality: 7, structure: 7, voice: 7 })).deps);
  assert.equal(media.status, 'approved');
  assert.equal(media.attempts.length, 5);
  assert.deepEqual(media.attempts.map((a) => a.decision), ['regenerate', 'regenerate', 'regenerate', 'regenerate', 'send_best']);
  assert.equal(media.attempts[4]!.gates.chosenAttempt, media.chosen!.attempt);

  const baja = await runQualityGate(gateInput(), deps(createFakeGenerator(), judgeWith({ relevance: 3, quality: 3, structure: 3, voice: 3 })).deps);
  assert.deepEqual([baja.status, baja.hold?.code, baja.attempts.length], ['hold', 'quality_low', 1]);

  const riesgo = await runQualityGate(gateInput(), deps(createFakeGenerator(), judgeWith({ relevance: 9, quality: 9, structure: 9, voice: 9 }, ['competitor_mention'])).deps);
  assert.deepEqual([riesgo.status, riesgo.hold], ['hold', { code: 'quality_risk', detail: 'competitor_mention' }]);
});

test('el tope diario de gasto: sin presupuesto no se genera; si se acaba a mitad, se retiene lo que haya', async () => {
  const sinNada = await runQualityGate(gateInput(), deps(createFakeGenerator(), createFakeJudge(), 0).deps);
  assert.deepEqual([sinNada.status, sinNada.attempts.length, sinNada.hold?.code], ['budget_exhausted', 0, 'llm_budget']);
  // Alcanza para generar (el falso no cuesta) pero no para el juez de sonnet.
  const aMitad = await runQualityGate(gateInput(), deps(createFakeGenerator(), judgeWith({ relevance: 9, quality: 9, structure: 9, voice: 9 }), 0.001).deps);
  assert.deepEqual([aMitad.status, aMitad.hold?.code, aMitad.attempts.length], ['hold', 'llm_budget', 1]);
});

test('dos marcas del mismo nicho reciben correos con similitud menor de 0,65', async () => {
  const a = await runQualityGate(gateInput(), deps(createFakeGenerator(), createFakeJudge()).deps);
  const enviadoA = a.chosen!.body;
  const b = await runQualityGate(
    gateInput({
      generation: generation({
        company: { name: 'Fresko Market', industry: 'alimentos', city: 'Bogotá', country: 'CO' },
        contact: { fullName: 'Andrés Pardo', roleTitle: 'Mercadeo' },
        signal: { headline: 'Abrió tienda en Chapinero', source: 'press_launches', detectedAt: null },
        avoid: [enviadoA],
      }),
      recentSent: [enviadoA],
    }),
    deps(createFakeGenerator(), createFakeJudge()).deps,
  );
  assert.equal(b.status, 'approved');
  const sim = textSimilarity(a.chosen!.cleanBody, b.chosen!.cleanBody);
  assert.ok(sim < 0.65, `similitud ${sim}`);
  assert.ok(b.attempts.every((x) => x.gates.similarity.max < 0.65));
});
