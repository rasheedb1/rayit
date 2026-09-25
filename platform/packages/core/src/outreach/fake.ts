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

function claimSentence(c: SalesClaim, k: number, lang: 'es' | 'en'): string {
  const lead = lang === 'en'
    ? pick(['One number from my profile:', 'For context,', 'A real figure:', 'What my numbers say:'], k)
    : pick(['Un dato de mi perfil:', 'Para que tengas contexto,', 'Te dejo una cifra real:', 'Lo que dicen mis números:'], k);
  return `${lead} ${lower(c.label)}, ${c.display} [claim:${c.id}].`;
}

/** El nicho del creador como se lee en una frase («estilo-de-vida» → «estilo de vida»), o null. */
function nicheOf(input: GenerationInput): string | null {
  const n = input.creator.niche?.replace(/[-_]+/g, ' ').trim();
  return n ? n : null;
}

/**
 * Las piezas del mensaje. Neutras respecto al nicho: el nicho del creador
 * entra como variable, nunca una frase de cocina en un espacio de fitness.
 */
function compose(input: GenerationInput, seed: number): Parts {
  const en = input.lang === 'en';
  const co = input.company.name;
  const who = firstNameOf(input.contact?.fullName) ?? null;
  // Una señal con cifras («6 anuncios activos», «30 % de descuento») no se copia: esas cifras no tienen claim.
  const headline = input.signal?.headline ?? null;
  const sig = headline && findFigures(headline).length === 0 ? lower(headline) : null;
  const where = input.company.city ?? input.company.country ?? (en ? 'your market' : 'tu mercado');
  const sector = input.company.industry ?? (en ? 'your industry' : 'tu sector');
  const niche = nicheOf(input);
  const n = (part: string) => hash(`${seed}|${part}|${co}|${who ?? ''}|${sig ?? ''}`);
  const allowed = input.claims.filter((c) => c.value !== null && (!input.angle || input.angle.proofSources.includes(c.source)));
  const claim = allowed.length > 0 ? pick(allowed, n('claim')) : null;
  const video = niche ? (en ? `a short ${niche} video` : `un video corto de ${niche}`) : en ? 'a short video' : 'un video corto';
  const t = en
    ? {
        greeting: who ? [`Hi ${who},`, `${who}, hello.`, `Good morning, ${who}.`, `Hello ${who},`] : ['Hi,', 'Hello,'],
        withSignal: [
          `I saw that ${co} ${sig} and started thinking about how I would tell it in ${video}.`,
          `What ${co} is doing (${sig}) is exactly the kind of move my audience follows closely.`,
          `It caught my eye that ${co} ${sig}, especially thinking about who buys in ${where}.`,
          `I was looking at the latest from ${co}: ${sig} fits what I publish every week.`,
        ],
        noSignal: [
          `I have been following what ${co} does in ${sector} for a while and there is something I want to pitch you.`,
          `Every time ${co} shows up in my feed I think about how my audience in ${where} would use it.`,
          `${co} talks to ${where} in a way that is very close to how I do.`,
        ],
        idea: [
          `I have in mind ${video} where ${co} fits into my day without feeling like an ad.`,
          `I am picturing a short series that shows ${co} in the real routine of the people who watch me, from morning to night.`,
          `I could put together a weekend challenge with ${co} at the center and my community joining from home.`,
          `I am thinking of a before and after video, told with humor, where ${co} solves the problem of the day.`,
          `I imagine a format where I answer my followers' questions with ${co} in hand.`,
        ],
        question: [
          `Would you like me to send you the full idea for ${co}?`,
          'Does it make sense to talk for a few minutes this week?',
          `Who on your team handles creator partnerships at ${co}?`,
          'Would it help if I shared two more concrete video ideas?',
        ],
        subject: [`${co} and a video idea`, `An idea for ${co} in ${where}`, `Your audience and mine in ${where}`, `A video for ${co}`],
      }
    : {
        greeting: who ? [`Hola ${who},`, `${who}, buenas.`, `Buen día, ${who}.`, `Hola, ${who}.`] : ['Hola,', 'Buen día,'],
        withSignal: [
          `Vi que ${co} ${sig} y me quedé pensando en cómo lo contaría en ${video}.`,
          `Lo de ${co} (${sig}) es justo el tipo de movimiento que mi audiencia sigue de cerca.`,
          `Me llamó la atención que ${co} ${sig}, sobre todo pensando en quién compra en ${where}.`,
          `Estuve mirando lo último de ${co}: que ${sig} encaja con lo que publico cada semana.`,
        ],
        noSignal: [
          `Sigo lo que hace ${co} en ${sector} desde hace un tiempo y hay algo que quiero proponerte.`,
          `Cada vez que ${co} aparece en mi feed pienso en cómo lo usaría mi audiencia en ${where}.`,
          `${co} tiene una forma de hablarle a ${where} que se parece mucho a la mía.`,
        ],
        idea: [
          `Se me ocurre ${video} donde ${co} entre en mi día a día sin que parezca un anuncio.`,
          `Tengo en mente una serie corta que muestre ${co} en la rutina real de quien me ve, de la mañana a la noche.`,
          `Podría armar un reto de fin de semana con ${co} como protagonista y la comunidad participando desde casa.`,
          `Pienso en un video de antes y después, contado con humor, donde ${co} resuelve el problema del día.`,
          `Me imagino un formato de preguntas de mis seguidores respondidas con ${co} en la mano.`,
        ],
        question: [
          `¿Te interesa que te mande la idea completa para ${co}?`,
          '¿Tiene sentido que lo hablemos unos minutos esta semana?',
          `¿Quién en tu equipo ve las colaboraciones con creadores en ${co}?`,
          '¿Te sirve si te comparto dos ideas de video más concretas?',
        ],
        subject: [`${co} y una idea de video`, `Una idea para ${co} en ${where}`, `Tu audiencia y la mía en ${where}`, `Un video para ${co}`],
      };
  return {
    greeting: pick(t.greeting, n('greet')),
    opener: sig ? pick(t.withSignal, n('open')) : pick(t.noSignal, n('open')),
    proof: claim ? claimSentence(claim, n('proof'), en ? 'en' : 'es') : '',
    idea: pick(t.idea, n('idea')),
    question: pick(t.question, n('ask')),
    sign: input.creator.name,
    subject: input.stepType === 'email' ? pick(t.subject, n('subject')) : null,
  };
}

function render(input: GenerationInput, p: Parts): { subject: string | null; body: string } {
  const st = input.stepType;
  if (st === 'linkedin_connect') {
    const close = input.lang === 'en' ? "I'd love to connect." : 'Me encantaría conectar.';
    return { subject: null, body: `${p.greeting} ${p.opener} ${close}`.slice(0, 290) };
  }
  if (st === 'linkedin_comment' || st === 'instagram_comment') return { subject: null, body: p.opener };
  const short = input.hint === 'shorter' || st === 'instagram_dm' || st === 'whatsapp_message';
  const middle = [p.opener, p.proof, short ? '' : p.idea].filter(Boolean).join(' ');
  return { subject: p.subject, body: [p.greeting, middle, p.question, p.sign].join('\n\n') };
}

/** El generador falso: en el idioma del workspace (español o inglés). Es para las pruebas y para la demo sin llave. */
export function createFakeGenerator(): MessageGenerator {
  return {
    name: 'fake',
    model: FAKE_GENERATOR_MODEL,
    async generate(input: GenerationInput): Promise<GeneratedMessage> {
      let out = render(input, compose(input, input.attempt));
      // Esquiva lo que ya salió a otras marcas: prueba otras combinaciones, siempre en el mismo orden.
      for (let k = 1; k < 24 && input.avoid.some((a) => textSimilarity(out.body, a) >= FAKE_AVOID_SIMILARITY); k++) {
        out = render(input, compose(input, input.attempt * 97 + k));
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
      const en = input.lang === 'en';
      const note = weak.length === 0
        ? en
          ? 'It talks about the brand from the first sentence, cites only sourced figures and closes with one question.'
          : 'Habla de la marca desde la primera frase, cita solo cifras con origen y cierra con una pregunta.'
        : `${en ? 'Could improve' : 'Mejorable en'}: ${weak.join(', ')}.`;
      return {
        scores, riskTriggers: [], hint: weak.length === 0 ? null : 'more_specific', note,
        model: FAKE_JUDGE_MODEL, inputTokens: tokensOf(input.body) + 400, outputTokens: 60, costUsd: 0,
      };
    },
  };
}
