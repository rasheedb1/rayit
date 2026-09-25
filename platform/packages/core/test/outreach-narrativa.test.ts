/**
 * VEN-11 · la narrativa del perfil: el verificador determinista (una
 * cifra inventada no pasa), la plantilla, el prompt, la llamada al
 * modelo detrás de una interfaz (sin red: un modelo falso con respuestas
 * escritas) y el costo de cada llamada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerfil, type Claim } from '../src/outreach/perfil.ts';
import {
  buildNarrativePrompt, narrativeSegments, perfilTerms, templateNarrative, verifyNarrative, writeNarrative,
  type NarrativeModel, type NarrativePrompt,
} from '../src/outreach/narrativa.ts';
import { llmCostUsd, UnknownModelPriceError } from '../src/outreach/llm-precios.ts';
import { entradasLaura } from './fixtures/perfil-entradas.ts';

const perfil = buildPerfil(entradasLaura());
const fmt = (c: Claim) => `${c.value} ${c.unit}`;

const BUENA = [
  'Soy Laura y cocino fácil. [claim:audiencia-tiktok-genero-f] de quienes me siguen en TikTok son mujeres, y la franja de 25-34 años es la más grande, con [claim:audiencia-tiktok-edad-25-34].',
  'Mi mediana en TikTok es de [claim:mediana-tiktok] views. «Cold brew en casa en 3 pasos» hizo [claim:video-000000000d01-x] veces mi mediana.',
  'Con Café Alma logramos [claim:campana-000000ca0001-views] views. Mi tarifa de «Historias (3)» empieza en [claim:tarifa-0000007a1103-desde].',
].join('\n\n');

test('una narrativa que solo cita claims de la lista pasa, con sus citas en orden', () => {
  const v = verifyNarrative(BUENA, perfil, { minClaims: 1 });
  assert.deepEqual(v.issues, []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.cited.slice(0, 3), ['audiencia-tiktok-genero-f', 'audiencia-tiktok-edad-25-34', 'mediana-tiktok']);
});

test('un claim inventado se rechaza', () => {
  const inventada = BUENA.replace('[claim:mediana-tiktok]', '[claim:mediana-tiktok-inventada]');
  const v = verifyNarrative(inventada, perfil);
  assert.equal(v.ok, false);
  assert.deepEqual(v.issues, [{ code: 'unknown_claim', id: 'mediana-tiktok-inventada' }]);
});

test('una cifra con dígitos fuera de una marca se rechaza, aunque sea verdad', () => {
  const v = verifyNarrative(BUENA.replace('[claim:mediana-tiktok]', '115.446'), perfil);
  assert.equal(v.ok, false);
  assert.deepEqual(v.issues, [{ code: 'bare_number', text: '115.446' }]);
  // Un porcentaje o un «3x» tampoco.
  const otra = verifyNarrative(BUENA.replace('Soy Laura', 'Soy Laura, con 64 % de mujeres y 3x'), perfil);
  assert.deepEqual(otra.issues.map((i) => i.code), ['bare_number', 'bare_number']);
});

test('los términos del perfil pueden llevar dígitos; sueltos, no', () => {
  assert.ok(perfilTerms(perfil).includes('Cold brew en casa en 3 pasos'));
  assert.ok(perfilTerms(perfil).includes('25-34'));
  assert.ok(!perfilTerms(perfil).includes('3'));
  const suelto = verifyNarrative(BUENA.replace('«Cold brew en casa en 3 pasos»', 'mi video de 3 pasos'), perfil);
  assert.deepEqual(suelto.issues, [{ code: 'bare_number', text: '3' }]);
});

test('marcas mal escritas, huecos y párrafos de más se rechazan', () => {
  const mala = verifyNarrative(BUENA.replace('[claim:mediana-tiktok]', '[claim: Mediana TikTok]'), perfil);
  assert.deepEqual(mala.issues, [{ code: 'malformed_marker', text: '[claim: Mediana TikTok]' }]);
  const hueco = verifyNarrative(BUENA.replace('Soy Laura', 'Soy {{nombre}}'), perfil);
  assert.deepEqual(hueco.issues.map((i) => i.code), ['placeholder']);
  const cuatro = verifyNarrative(`${BUENA}\n\nUn cuarto párrafo.`, perfil);
  assert.deepEqual(cuatro.issues, [{ code: 'paragraphs', expected: 3, found: 4 }]);
  // La edición del creador puede tener de uno a cinco párrafos.
  assert.equal(verifyNarrative(`${BUENA}\n\nUn cuarto párrafo.`, perfil, { paragraphs: null }).ok, true);
  assert.deepEqual(verifyNarrative('  ', perfil).issues, [{ code: 'empty' }]);
  assert.deepEqual(verifyNarrative('Uno.\n\nDos.\n\nTres.', perfil, { minClaims: 1 }).issues, [{ code: 'no_claims' }]);
  assert.equal(verifyNarrative(`${BUENA} ${'palabra '.repeat(400)}`, perfil).issues[0]!.code, 'too_long');
});

test('la plantilla es determinista, tiene tres párrafos y pasa el verificador', () => {
  const t = templateNarrative(perfil);
  assert.equal(t, templateNarrative(buildPerfil(entradasLaura())));
  const v = verifyNarrative(t, perfil, { minClaims: 1 });
  assert.deepEqual(v.issues, []);
  assert.ok(v.cited.includes('video-000000000d01-x'));
  assert.ok(v.cited.includes('campana-000000ca0001-views'));
  assert.match(t, /«Cold brew en casa en 3 pasos»/);
});

test('la plantilla de un creador sin datos también pasa', () => {
  const e = entradasLaura();
  const vacio = buildPerfil({ ...e, connections: [], audience: [], nonFollowers: [], baselines: [], posts: [], campaigns: [], rateCard: null });
  const t = templateNarrative(vacio);
  assert.equal(verifyNarrative(t, vacio).ok, true);
  assert.match(t, /Todavía no tengo campañas con resultado medido/);
});

test('las marcas se pintan como cifras; una marca huérfana queda como texto', () => {
  const [p1] = narrativeSegments('Hola [claim:mediana-tiktok] y [claim:no-existe].', perfil);
  assert.deepEqual(p1!.map((s) => s.kind), ['text', 'claim', 'text']);
  assert.equal(p1![1]!.kind === 'claim' && p1![1]!.claim.value, 115446);
  assert.equal(p1![2]!.kind === 'text' && p1![2]!.text, ' y [claim:no-existe].');
});

test('el prompt lleva cada claim con su valor y las reglas de la marca', () => {
  const p = buildNarrativePrompt(perfil, fmt);
  assert.match(p.system, /Toda cifra se escribe SOLO como su marca, \[claim:id\]/);
  for (const c of perfil.claims) assert.ok(p.user.includes(`[claim:${c.id}] → ${c.label}: ${c.value} ${c.unit}`), c.id);
  assert.match(p.user, /Video uno: «Cold brew en casa en 3 pasos» en Instagram\. Por qué funcionó: abre con una promesa/);
});

/** Un modelo falso: devuelve las respuestas en orden y guarda los prompts. */
function falso(respuestas: Array<string | Error>): NarrativeModel & { prompts: NarrativePrompt[] } {
  const prompts: NarrativePrompt[] = [];
  return {
    model: 'claude-sonnet-5',
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      const r = respuestas.shift();
      if (r === undefined) throw new Error('sin respuesta');
      if (r instanceof Error) throw r;
      return { text: r, inputTokens: 3000, outputTokens: 400 };
    },
  };
}

test('con modelo, la narrativa que pasa se guarda como del modelo, con los tokens de la llamada', async () => {
  const m = falso([BUENA]);
  const r = await writeNarrative(perfil, { model: m, formatClaim: fmt });
  assert.equal(r.source, 'llm');
  assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(r.text, BUENA);
  assert.deepEqual(r.calls, [{ model: 'claude-sonnet-5', inputTokens: 3000, outputTokens: 400 }]);
});

test('un claim inventado por el modelo se rechaza: segundo intento con el motivo, y si falla, plantilla', async () => {
  const inventada = BUENA.replace('[claim:mediana-tiktok]', '[claim:clientes-felices]');
  const m = falso([inventada, BUENA]);
  const r = await writeNarrative(perfil, { model: m, formatClaim: fmt });
  assert.equal(r.source, 'llm');
  assert.equal(r.calls.length, 2);
  assert.match(m.prompts[1]!.user, /La marca \[claim:clientes-felices\] no existe/);

  const terca = falso([inventada, inventada]);
  const r2 = await writeNarrative(perfil, { model: terca, formatClaim: fmt });
  assert.equal(r2.source, 'template');
  assert.equal(r2.fallback, 'rejected');
  assert.equal(r2.calls.length, 2, 'las dos llamadas rechazadas también se registran');
  assert.deepEqual(r2.issues, [{ code: 'unknown_claim', id: 'clientes-felices' }]);
  assert.equal(verifyNarrative(r2.text, perfil).ok, true);
});

test('sin modelo, con el tope alcanzado o con la API caída, la plantilla y el motivo', async () => {
  assert.equal((await writeNarrative(perfil, { model: null, formatClaim: fmt })).fallback, 'no_model');
  const m = falso([BUENA]);
  const r = await writeNarrative(perfil, { model: m, formatClaim: fmt, budgetExhausted: true });
  assert.equal(r.fallback, 'budget');
  assert.equal(m.prompts.length, 0, 'con el tope alcanzado no se llama');
  const caida = await writeNarrative(perfil, { model: falso([new Error('529 overloaded')]), formatClaim: fmt });
  assert.deepEqual([caida.source, caida.fallback, caida.calls.length], ['template', 'error', 0]);
});

test('el costo de una llamada, en decimal de seis cifras y sin float', () => {
  assert.equal(llmCostUsd({ model: 'claude-sonnet-5', inputTokens: 3000, outputTokens: 400 }), '0.010000');
  assert.equal(llmCostUsd({ model: 'claude-haiku-4-5-20251001', inputTokens: 1, outputTokens: 0 }), '0.000001');
  assert.equal(llmCostUsd({ model: 'claude-sonnet-5', inputTokens: 2_000_000, outputTokens: 100_000 }), '5.000000');
  assert.throws(() => llmCostUsd({ model: 'otro-modelo', inputTokens: 1, outputTokens: 1 }), UnknownModelPriceError);
  assert.throws(() => llmCostUsd({ model: 'claude-sonnet-5', inputTokens: -1, outputTokens: 1 }), RangeError);
});
