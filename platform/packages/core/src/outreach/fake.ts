/**
 * El generador y el juez falsos (VEN-12): deterministas, sin red y sin
 * llave. Los usan las pruebas y el worker cuando falta ANTHROPIC_API_KEY
 * (la pantalla dice entonces que la redacción con IA no está configurada).
 *
 * No son un eco: el generador compone el mensaje con lo que recibe (la
 * marca, su señal, el contacto, los claims que el ángulo deja citar) y
 * elige cada parte de varias variantes por un hash estable, esquivando lo
 * que se parezca a los mensajes ya enviados a otras marcas. Así la puerta
 * de calidad se prueba de verdad: dos marcas del mismo nicho no reciben el
 * mismo texto con el nombre cambiado.
 */
import { findFigures, type SalesClaim } from './claims.ts';
import type { GeneratedMessage, GenerationInput, MessageGenerator } from './generate.ts';
import { textSimilarity } from './gates.ts';
import { RUBRIC_DIMENSIONS, type JudgeInput, type JudgeVerdict, type MessageJudge, type RubricScores } from './judge.ts';
import { firstNameOf } from './render.ts';

export const FAKE_GENERATOR_MODEL = 'on-cue-fake-generator';
export const FAKE_JUDGE_MODEL = 'on-cue-fake-judge';
/** Por debajo de esto contra lo ya enviado, el falso da por buena su composición. */
export const FAKE_AVOID_SIMILARITY = 0.35;

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const pick = <T>(xs: readonly T[], n: number): T => xs[n % xs.length]!;
const tokensOf = (s: string) => Math.max(1, Math.ceil(s.length / 4));

interface Parts {
  greeting: string;
  opener: string;
  proof: string;
  idea: string;
  question: string;
  sign: string;
  subject: string | null;
}

function lower(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function claimSentence(c: SalesClaim, k: number): string {
  const lead = pick(['Un dato de mi perfil:', 'Para que tengas contexto,', 'Te dejo una cifra real:', 'Lo que dicen mis números:'], k);
  return `${lead} ${lower(c.label)}, ${c.display} [claim:${c.id}].`;
}

function composeEs(input: GenerationInput, seed: number): Parts {
  const co = input.company.name;
  const who = firstNameOf(input.contact?.fullName) ?? null;
  // Una señal con cifras («6 anuncios activos», «30 % de descuento») no se copia: esas cifras no tienen claim.
  const headline = input.signal?.headline ?? null;
  const sig = headline && findFigures(headline).length === 0 ? lower(headline) : null;
  const where = input.company.city ?? input.company.country ?? 'tu mercado';
  const sector = input.company.industry ?? 'tu sector';
  const n = (part: string) => hash(`${seed}|${part}|${co}|${who ?? ''}|${sig ?? ''}`);
  const allowed = input.claims.filter((c) => c.value !== null && (!input.angle || input.angle.proofSources.includes(c.source)));
  const claim = allowed.length > 0 ? pick(allowed, n('claim')) : null;
  return {
    greeting: who ? pick([`Hola ${who},`, `${who}, buenas.`, `Buen día, ${who}.`, `Hola, ${who}.`], n('greet')) : pick(['Hola,', 'Buen día,'], n('greet')),
    opener: sig
      ? pick([
          `Vi que ${co} ${sig} y me quedé pensando en cómo lo contaría en un video corto.`,
          `Lo de ${co} (${sig}) es justo el tipo de movimiento que mi audiencia sigue de cerca.`,
          `Me llamó la atención que ${co} ${sig}, sobre todo pensando en quién compra en ${where}.`,
          `Estuve mirando lo último de ${co}: que ${sig} encaja con lo que publico cada semana.`,
        ], n('open'))
      : pick([
          `Sigo lo que hace ${co} en ${sector} desde hace un tiempo y hay algo que quiero proponerte.`,
          `Cada vez que ${co} aparece en mi feed pienso en cómo lo usaría mi audiencia en ${where}.`,
          `${co} tiene una forma de hablarle a ${where} que se parece mucho a la mía.`,
        ], n('open')),
    proof: claim ? claimSentence(claim, n('proof')) : '',
    idea: pick([
      `Se me ocurre una receta rápida donde ${co} sea parte del paso a paso, sin que parezca un anuncio.`,
      `Tengo en mente una serie corta que muestre ${co} en la rutina real de quien me ve, de la mañana a la noche.`,
      `Podría armar un reto de fin de semana con ${co} como protagonista y la comunidad cocinando en casa.`,
      `Pienso en un video de antes y después, contado con humor, donde ${co} resuelve el problema del día.`,
      `Me imagino un formato de preguntas de mis seguidores respondidas con ${co} en la mesa.`,
    ], n('idea')),
    question: pick([
      `¿Te interesa que te mande la idea completa para ${co}?`,
      '¿Tiene sentido que lo hablemos unos minutos esta semana?',
      `¿Quién en tu equipo ve las colaboraciones con creadores en ${co}?`,
      '¿Te sirve si te comparto dos ideas de video más concretas?',
    ], n('ask')),
    sign: input.creator.name,
    subject: input.stepType === 'email'
      ? pick([`${co} y una idea de video`, `Una idea para ${co} en ${where}`, `Tu audiencia y la mía en ${where}`, `Un video para ${co}`], n('subject'))
      : null,
  };
}

function render(input: GenerationInput, p: Parts): { subject: string | null; body: string } {
  const st = input.stepType;
  if (st === 'linkedin_connect') return { subject: null, body: `${p.greeting} ${p.opener} Me encantaría conectar.`.slice(0, 290) };
  if (st === 'linkedin_comment' || st === 'instagram_comment') return { subject: null, body: p.opener };
  const short = input.hint === 'shorter' || st === 'instagram_dm' || st === 'whatsapp_message';
  const middle = [p.opener, p.proof, short ? '' : p.idea].filter(Boolean).join(' ');
  return { subject: p.subject, body: [p.greeting, middle, p.question, p.sign].join('\n\n') };
}

/** El generador falso. Escribe en español en cualquier idioma: es para las pruebas y para la demo sin llave. */
export function createFakeGenerator(): MessageGenerator {
  return {
    name: 'fake',
    model: FAKE_GENERATOR_MODEL,
    async generate(input: GenerationInput): Promise<GeneratedMessage> {
      let out = render(input, composeEs(input, input.attempt));
      // Esquiva lo que ya salió a otras marcas: prueba otras combinaciones, siempre en el mismo orden.
      for (let k = 1; k < 24 && input.avoid.some((a) => textSimilarity(out.body, a) >= FAKE_AVOID_SIMILARITY); k++) {
        out = render(input, composeEs(input, input.attempt * 97 + k));
      }
      return { ...out, model: FAKE_GENERATOR_MODEL, inputTokens: tokensOf(JSON.stringify(input)), outputTokens: tokensOf(out.body), costUsd: 0 };
    },
  };
}

/**
 * El juez falso: califica con señales que se ven en el texto (la marca en
 * la primera frase, la señal citada, una sola pregunta, el largo) y no
 * inventa riesgos. Con un texto del generador falso la nota pasa el umbral.
 */
export function createFakeJudge(): MessageJudge {
  return {
    name: 'fake',
    model: FAKE_JUDGE_MODEL,
    async judge(input: JudgeInput): Promise<JudgeVerdict> {
      const firstLines = input.body.split('\n').slice(0, 3).join(' ').toLowerCase();
      const mentionsBrand = firstLines.includes(input.company.name.toLowerCase());
      const questions = (input.body.match(/\?/g) ?? []).length;
      const scores: RubricScores = {
        relevance: mentionsBrand ? 9 : 6,
        quality: /!{2,}/.test(input.body) ? 6 : 8.5,
        structure: questions === 1 ? 9 : 6,
        voice: 8.5,
      };
      const weak = RUBRIC_DIMENSIONS.filter((d) => scores[d] < 8);
      const note = weak.length === 0
        ? 'Habla de la marca desde la primera frase, cita solo cifras con origen y cierra con una pregunta.'
        : `Mejorable en: ${weak.join(', ')}.`;
      return {
        scores, riskTriggers: [], hint: weak.length === 0 ? null : 'more_specific', note,
        model: FAKE_JUDGE_MODEL, inputTokens: tokensOf(input.body) + 400, outputTokens: 60, costUsd: 0,
      };
    },
  };
}
