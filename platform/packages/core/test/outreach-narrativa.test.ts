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
  buildNarrativePrompt, CANTIDADES, claimLabelEs, claimsById, narrativeIssueSpans, narrativeLanguage, narrativeSegments, perfilTerms,
  templateNarrative, verifierContext, verifyNarrative, verifyNarrativeWith, writeNarrative, type NarrativeModel, type NarrativePrompt,
} from '../src/outreach/narrativa.ts';
import type { LlmUsage } from '../src/outreach/llm-precios.ts';
import { llmCostUsd, UnknownModelPriceError } from '../src/outreach/llm-precios.ts';
import { entradasConVideosLargos, entradasLaura } from './fixtures/perfil-entradas.ts';

const perfil = buildPerfil(entradasLaura());
const fmt = (c: Claim) => `${c.value} ${c.unit}`;

const BUENA = [
  'Soy Laura y cocino fácil. [claim:audiencia-tiktok-genero-f] de quienes me siguen en TikTok son mujeres, y la franja de 25-34 años es la más grande, con [claim:audiencia-tiktok-edad-25-34].',
  'Mi mediana en TikTok es de [claim:mediana-tiktok] views. «Cold brew en casa en 3 pasos» hizo [claim:video-000000000d01-x] mi mediana.',
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
  assert.deepEqual(otra.issues.map((i) => i.code), ['bare_number', 'bare_number', 'number_word']);
});

test('los términos del perfil pueden llevar dígitos; sueltos, no', () => {
  assert.ok(perfilTerms(perfil).includes('Cold brew en casa en 3 pasos'));
  assert.ok(perfilTerms(perfil).includes('25-34'));
  assert.ok(!perfilTerms(perfil).includes('3'));
  const suelto = verifyNarrative(BUENA.replace('«Cold brew en casa en 3 pasos»', 'mi video de 3 pasos'), perfil);
  assert.deepEqual(suelto.issues, [{ code: 'bare_number', text: '3' }]);
});

test('una cantidad en letras o un signo de cifra fuera de una marca se rechaza', () => {
  const con = (frase: string) => verifyNarrative(BUENA.replace('Soy Laura y cocino fácil.', frase), perfil, { paragraphs: null });
  assert.deepEqual(con('Soy Laura, con un millón de seguidores.').issues, [{ code: 'number_word', text: 'millón' }]);
  assert.deepEqual(con('Soy Laura y tengo dos millones de fans.').issues, [
    { code: 'number_word', text: 'dos' }, { code: 'number_word', text: 'millones' },
  ]);
  assert.deepEqual(con('Mis videos hacen doce mil views.').issues.map((i) => i.code), ['number_word', 'number_word']);
  assert.deepEqual(con('Mi mejor video hizo el doble de mi mediana.').issues, [{ code: 'number_word', text: 'doble' }]);
  assert.deepEqual(con('La mitad de mi audiencia es de México.').issues, [{ code: 'number_word', text: 'mitad' }]);
  assert.deepEqual(con('Crecí un veinte por ciento.').issues, [
    { code: 'number_word', text: 'veinte' }, { code: 'number_word', text: 'por ciento' },
  ]);
  // «50 %»: el dígito y el signo, cada uno con su código.
  assert.deepEqual(con('Soy Laura: 50 % de mujeres.').issues, [{ code: 'bare_number', text: '50' }, { code: 'number_word', text: '%' }]);
  // Un signo pegado a una marca repite lo que la cifra ya trae.
  assert.deepEqual(con('Hice [claim:video-000000000d01-x]× mi mediana.').issues, [{ code: 'number_word', text: '×' }]);
  // «un», «una» y «uno» son artículos: no son cifras.
  assert.equal(con('Soy Laura, una cocinera, y uno de mis videos es un reel.').ok, true);
  // Dentro de un término del perfil, un número en letras no es una cifra: es el título.
  assert.equal(con('Mi video «Pasta cremosa en cuatro minutos» funciona.').ok, true);
  assert.equal(con('Mi video «Tres desayunos con dos ingredientes» funciona.').ok, true);
  assert.equal(con('Hice cuatro minutos de pasta.').ok, false);
});

test('los verbos que multiplican y los puestos de ranking también son cifras sin marca', () => {
  const con = (frase: string) => verifyNarrative(BUENA.replace('Soy Laura y cocino fácil.', frase), perfil, { paragraphs: null });
  // Lo que pasó en la edición real de r2.
  assert.deepEqual(con('Este año cuadrupliqué mis views.').issues, [{ code: 'number_word', text: 'cuadrupliqué' }]);
  for (const verbo of ['dupliqué', 'triplicó', 'duplicar', 'multipliqué', 'Multiplicamos', 'quintuplicaron']) {
    assert.deepEqual(con(`Mis views se ${verbo} en un mes.`).issues.map((i) => i.code), ['number_word'], verbo);
  }
  assert.deepEqual(con('Soy la número uno de Colombia en recetas.').issues, [{ code: 'number_word', text: 'número uno' }]);
  assert.deepEqual(con('Quedé en primer lugar del ranking.').issues, [{ code: 'number_word', text: 'primer lugar' }]);
  assert.deepEqual(con('Estoy en el top de cocina.').issues, [{ code: 'number_word', text: 'top' }]);
  // Con límite de palabra: «duplicado» sí (es la raíz), «topo» o «laptop» no.
  assert.equal(con('Mi laptop y un topo en la cocina.').ok, true);
  // Las listas van por idioma: añadir uno es añadir sus datos.
  assert.deepEqual(Object.keys(CANTIDADES), ['es']);
  assert.equal(narrativeLanguage('es-CO'), 'es');
  assert.equal(narrativeLanguage('en-US'), 'es');
  assert.equal(narrativeLanguage(null), 'es');
});

test('la vista previa sabe dónde está cada problema, con la misma regla que la puerta del servidor', () => {
  const ctx = verifierContext(perfil);
  // Datos planos: viajan al cliente.
  assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
  const texto = 'Tengo [claim:inventada] y 3 millones; «Cold brew en casa en 3 pasos» hizo [claim:video-000000000d01-x].';
  const spans = narrativeIssueSpans(texto, ctx);
  assert.deepEqual(spans.map((s) => [s.code, texto.slice(s.start, s.end)]), [
    ['unknown_claim', '[claim:inventada]'], ['bare_number', '3'], ['number_word', 'millones'],
  ]);
  // El 3 del título no se marca: es un término del perfil.
  assert.equal(spans.filter((s) => s.code === 'bare_number').length, 1);
  // La misma respuesta que verifyNarrative.
  assert.deepEqual(verifyNarrativeWith(texto, ctx, { paragraphs: null }), verifyNarrative(texto, perfil, { paragraphs: null }));
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
  assert.deepEqual(verifyNarrative('Hola.\n\nQué tal.\n\nAdiós.', perfil, { minClaims: 1 }).issues, [{ code: 'no_claims' }]);
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

test('la plantilla compara cifras comparables: la mediana de la red del mejor video, y la de su corte', () => {
  const t = templateNarrative(perfil);
  // La mediana que se cita es la de Instagram, la red del mejor video, con su corte en palabras.
  assert.match(t, /En Instagram, a la semana de publicado, mis videos tienen una mediana de \[claim:mediana-instagram\] views\./);
  // El «× mi mediana» nombra la red, y como se midió a los treinta días, cita esa mediana (412 000 ≈ 5,97 × 69 000).
  assert.match(
    t,
    /llegó a \[claim:video-000000000d01-views\] views al mes de publicado: \[claim:video-000000000d01-x\] mi mediana de Instagram, que a esa edad es de \[claim:mediana-instagram-ba5207200001\] views\./,
  );
  // Con el seed ningún rasgo alcanza: la plantilla describe el video y no le inventa una causa.
  assert.match(t, /Ese video abre con una promesa concreta de resultado y es una colaboración con una marca\./);
  assert.doesNotMatch(t, /porque-/);
  // Con videos para comparar, cita la razón con los OTROS videos, no con el mismo.
  const conRazon = templateNarrative(buildPerfil(entradasConVideosLargos()));
  assert.match(
    conRazon,
    /Y no es casualidad: mis otros videos cortos hacen \[claim:porque-000000000d01-duracion-corto\] mi mediana, frente a \[claim:porque-000000000d01-duracion-corto-resto\] de los demás\./,
  );
  assert.ok(verifyNarrative(conRazon, buildPerfil(entradasConVideosLargos()), { minClaims: 1 }).ok);
  // Los rasgos de tono con el mismo verbo, juntos.
  assert.match(t, /En mis captions escribo corto y uso emojis y hashtags\./);
  assert.doesNotMatch(t, /uso emojis y uso/);
});

test('la plantilla no dice «mujeres» de un segmento sin especificar', () => {
  const e = entradasLaura();
  e.audience = e.audience.filter((a) => a.dimension !== 'gender');
  e.audience.push(
    { id: 'g-u', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'gender', bucket: 'U', share: 0.5, day: '2026-09-24' },
    { id: 'g-f', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'gender', bucket: 'F', share: 0.3, day: '2026-09-24' },
    { id: 'g-m', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'gender', bucket: 'M', share: 0.2, day: '2026-09-24' },
  );
  const conU = buildPerfil(e);
  const t = templateNarrative(conU);
  assert.match(t, /\[claim:audiencia-tiktok-genero-f\] son mujeres/);
  assert.doesNotMatch(t, /genero-u\] son/);
  assert.equal(verifyNarrative(t, conU).ok, true);
  // Solo 'U': la frase de género se omite.
  e.audience = e.audience.filter((a) => a.id !== 'g-f' && a.id !== 'g-m');
  const soloU = templateNarrative(buildPerfil(e));
  assert.doesNotMatch(soloU, /son (mujeres|hombres)/);
  assert.match(soloU, /\[claim:audiencia-tiktok-edad-25-34\] está en la franja de 25-34 años/);
});

test('la plantilla de un creador sin datos también pasa', () => {
  const e = entradasLaura();
  const vacio = buildPerfil({ ...e, connections: [], audience: [], nonFollowers: [], baselines: [], posts: [], campaigns: [], rateCard: null });
  const t = templateNarrative(vacio);
  assert.equal(verifyNarrative(t, vacio).ok, true);
  assert.match(t, /Todavía no tengo campañas con resultado medido/);
});

test('las marcas se pintan como cifras; una marca huérfana queda como texto', () => {
  const [p1] = narrativeSegments('Hola [claim:mediana-tiktok] y [claim:no-existe].', claimsById(perfil));
  assert.deepEqual(p1!.map((s) => s.kind), ['text', 'claim', 'text']);
  assert.equal(p1![1]!.kind === 'claim' && p1![1]!.claim.value, 115446);
  assert.equal(p1![2]!.kind === 'text' && p1![2]!.text, ' y [claim:no-existe].');
});

test('el prompt lleva cada claim con su valor y las reglas de la marca', () => {
  const p = buildNarrativePrompt(perfil, fmt);
  assert.match(p.system, /Toda cifra se escribe SOLO como su marca, \[claim:id\]/);
  for (const c of perfil.claims) assert.ok(p.user.includes(`[claim:${c.id}] → ${claimLabelEs(c)}: ${c.value} ${c.unit}`), c.id);
  assert.match(p.user, /Video uno: «Cold brew en casa en 3 pasos» en Instagram\. Cómo es: abre con una promesa/);
  // Sin razón, el prompt pide describir el video y no inventar una causa.
  assert.match(p.user, /Lo que lo distingue: los datos no alcanzan para decir qué lo separa de sus demás videos; describe cómo es y no inventes una razón/);
  const conRazon = buildPerfil(entradasConVideosLargos());
  const q = buildNarrativePrompt(conRazon, fmt);
  assert.match(q.user, /sus otros videos que son cortos hacen \[claim:porque-000000000d01-duracion-corto\] frente a \[claim:porque-000000000d01-duracion-corto-resto\] de los que no/);
  assert.equal(
    claimLabelEs(conRazon.claims.find((c) => c.id === 'porque-000000000d01-duracion-corto')!),
    'Veces su mediana, mediana de sus OTROS videos que son cortos (sin contar «Cold brew en casa en 3 pasos»)',
  );
  // Las etiquetas del prompt salen de la clave y los parámetros, con el país en el locale que se pida.
  assert.equal(claimLabelEs(perfil.claims.find((c) => c.id === 'audiencia-tiktok-pais-mx')!, 'en'), 'Parte de los seguidores de TikTok que vive en Mexico');
  assert.equal(claimLabelEs(perfil.claims.find((c) => c.id === 'mediana-instagram-ba5207200001')!), 'Views medianas por video en Instagram al mes de publicado');
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

test('cada llamada se registra apenas responde, y el tope se vuelve a mirar antes del segundo intento', async () => {
  const inventada = BUENA.replace('[claim:mediana-tiktok]', '[claim:clientes-felices]');
  const registradas: LlmUsage[] = [];
  let consultas = 0;
  const m = falso([inventada, BUENA]);
  const r = await writeNarrative(perfil, {
    model: m,
    formatClaim: fmt,
    onCall: (u) => { registradas.push(u); },
    // El primer intento llevó el gasto al tope.
    budgetExhausted: async () => consultas++ > 0,
  });
  assert.equal(consultas, 2);
  assert.equal(m.prompts.length, 1, 'con el tope alcanzado no hay segundo intento');
  assert.deepEqual([r.source, r.fallback], ['template', 'budget']);
  assert.deepEqual(registradas, [{ model: 'claude-sonnet-5', inputTokens: 3000, outputTokens: 400 }]);
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
