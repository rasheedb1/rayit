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
import { withoutDates, type SalesClaim } from './claims.ts';
import { platformName } from './claim-labels.ts';
import type { GeneratedMessage, GenerationInput, MessageGenerator } from './generate.ts';
import { textSimilarity } from './gates.ts';
import { RUBRIC_DIMENSIONS, type JudgeInput, type JudgeVerdict, type MessageJudge, type RubricScores } from './judge.ts';
import { RUBRIC_DIMENSION_LABELS } from './messages.ts';
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

/**
 * La cifra dicha como la diría la creadora, según qué es: «Mis videos de
 * TikTok tienen una mediana de 115.446 [claim:…] visualizaciones». Lo que no tiene
 * frase propia cae en una genérica con su etiqueta.
 */
function claimSentence(c: SalesClaim, k: number, lang: 'es' | 'en', companyName: string): string {
  const m = `${c.display} [claim:${c.id}]`;
  const [kind, a = '', b = '', bucket = ''] = c.id.split(':');
  const P = platformName(a);
  const brand = c.entities?.[0] ?? null;
  // Una campaña con ESTA marca ya se nombró al abrir («Después de nuestra campaña con…»): aquí es «esa campaña».
  const same = brand !== null && brand.toLowerCase() === companyName.toLowerCase();
  const en = lang === 'en';
  if (kind === 'baseline' && b === 'median_views') {
    return en
      ? pick([`My ${P} videos get a median of ${m} views in their first week.`, `On ${P}, a typical video of mine reaches ${m} views in its first week.`], k)
      : pick([`Mis videos de ${P} tienen una mediana de ${m} visualizaciones en su primera semana.`, `En ${P}, un video mío típico llega a ${m} visualizaciones en su primera semana.`], k);
  }
  if (kind === 'baseline' && b === 'median_engagement') {
    return en ? `On ${P}, the median engagement on my videos is ${m}.` : `En ${P}, la interacción mediana de mis videos es del ${m}.`;
  }
  if (kind === 'campaign' && brand && same) {
    const byMetric: Record<string, [string, string]> = {
      views: [`That campaign reached ${m} views.`, `Esa campaña sumó ${m} visualizaciones.`],
      redemptions: [`In that campaign, ${m} codes were redeemed.`, `En esa campaña se redimieron ${m} códigos.`],
      non_followers: [`In that campaign, ${m} of the reach came from people who did not follow me yet.`, `En esa campaña, el ${m} del alcance fue gente que todavía no me seguía.`],
      brand_followers: [`With that campaign, you gained ${m} followers.`, `Con esa campaña ganaron ${m} seguidores.`],
    };
    const s = byMetric[b];
    if (s) return en ? s[0] : s[1];
  }
  if (kind === 'campaign' && brand) {
    const byMetric: Record<string, [string, string]> = {
      views: [`The campaign I did with ${brand} reached ${m} views.`, `La campaña que hice con ${brand} sumó ${m} visualizaciones.`],
      redemptions: [`In the campaign with ${brand}, ${m} codes were redeemed.`, `En la campaña con ${brand} se redimieron ${m} códigos.`],
      non_followers: [
        `In the campaign with ${brand}, ${m} of the reach came from people who did not follow me yet.`,
        `En la campaña con ${brand}, el ${m} del alcance fue gente que todavía no me seguía.`,
      ],
      brand_followers: [`With our campaign, ${brand} gained ${m} followers.`, `Con nuestra campaña, ${brand} ganó ${m} seguidores.`],
    };
    const s = byMetric[b];
    if (s) return en ? s[0] : s[1];
  }
  if (kind === 'audience' && b === 'gender' && (bucket === 'f' || bucket === 'm')) {
    const who = en ? (bucket === 'f' ? 'women' : 'men') : bucket === 'f' ? 'mujeres' : 'hombres';
    return en ? `On ${P}, ${m} of the people who follow me are ${who}.` : `En ${P}, el ${m} de quienes me siguen son ${who}.`;
  }
  const age = kind === 'audience' && b === 'age' ? /^(\d{2})-(\d{2})$/.exec(bucket) : null;
  if (age) {
    return en
      ? `On ${P}, ${m} of the people who follow me are between ${age[1]} and ${age[2]} years old.`
      : `En ${P}, el ${m} de quienes me siguen tiene entre ${age[1]} y ${age[2]} años.`;
  }
  if (kind === 'media_kit' && b === 'followers') return en ? `I have ${m} followers on ${P}.` : `Tengo ${m} seguidores en ${P}.`;
  return en ? `A number from my profile that may help: ${lower(c.label)}, ${m}.` : `Un dato de mi perfil que te puede servir: ${lower(c.label)}, ${m}.`;
}

/**
 * La cifra que respalda el mensaje, por prioridad y no al azar: una
 * campaña con ESTA marca; la mediana de views de la red principal del
 * creador (la de más views); su interacción; su audiencia en esa red; lo
 * demás. El hash solo desempata dentro de un mismo nivel.
 */
function proofClaim(allowed: readonly SalesClaim[], companyName: string, n: number, exclude: string | null): SalesClaim | null {
  const xs = allowed.filter((c) => c.id !== exclude);
  const co = companyName.toLowerCase();
  const views = xs.filter((c) => /^baseline:[^:]+:median_views$/.test(c.id)).sort((p, q) => (q.value ?? 0) - (p.value ?? 0));
  const main = views[0]?.id.split(':')[1] ?? null;
  const onMain = (c: SalesClaim) => main !== null && c.id.split(':')[1] === main;
  const tiers: SalesClaim[][] = [
    xs.filter((c) => c.source === 'campaign_result' && (c.entities ?? []).some((e) => e.toLowerCase() === co)),
    views.slice(0, 1),
    xs.filter((c) => c.source === 'creator_baseline' && onMain(c)),
    xs.filter((c) => c.id.startsWith('audience:') && onMain(c)),
    xs.filter((c) => c.source === 'creator_baseline' || c.source === 'media_kit'),
    xs.filter((c) => c.id.startsWith('audience:')),
    xs.filter((c) => c.source !== 'signal'),
  ];
  const tier = tiers.find((t) => t.length > 0);
  return tier ? pick(tier, n) : null;
}

/**
 * La señal como se cita en una frase: sin el sufijo « · categoría», solo
 * si no trae números fuera de sus fechas (esos números no tienen claim y
 * el redactor no los copia) y si empieza por un verbo en pasado («Lanzó
 * cold brew en botella el 22 jul»): «Top Ads en TikTok» no se lee detrás
 * de «Vi que Café Alma…».
 */
function quotableSignal(headline: string | null): string | null {
  const main = headline?.split(' · ')[0]?.trim() ?? '';
  if (!main || /\d/.test(withoutDates(main))) return null;
  return /^\p{L}+(?:ó|aron|ieron|ed)(?![\p{L}])/u.test(main) ? lower(main) : null;
}

/** El nicho del creador como se lee en una frase («estilo-de-vida» → «estilo de vida»), o null. */
function nicheOf(input: GenerationInput): string | null {
  const n = input.creator.niche?.replace(/[-_]+/g, ' ').trim();
  return n ? n : null;
}

/**
 * Las piezas del mensaje. Neutras respecto al nicho: el nicho del creador
 * entra como variable, nunca una frase de cocina en un espacio de fitness.
 * La marca se nombra al abrir y, como mucho, una vez más (ronda 5): la
 * idea y la pregunta hablan de «su producto» o «la marca». Si ya hicieron
 * una campaña juntos, se abre con esa relación, no como un correo en frío.
 */
function compose(input: GenerationInput, seed: number): Parts {
  const en = input.lang === 'en';
  const co = input.company.name;
  const who = firstNameOf(input.contact?.fullName) ?? null;
  // Una señal con cifras («6 anuncios activos», «30 % de descuento») no se copia tal cual: esas cifras no tienen marca.
  // Si la cifra de la señal es un claim que el ángulo deja citar, se dice con su marca («6 [claim:…] anuncios activos»).
  const sig = quotableSignal(input.signal?.headline ?? null);
  const where = input.company.city ?? input.company.country ?? (en ? 'your market' : 'tu mercado');
  const sector = input.company.industry ?? (en ? 'your industry' : 'tu sector');
  const niche = nicheOf(input);
  const n = (part: string) => hash(`${seed}|${part}|${co}|${who ?? ''}|${sig ?? ''}`);
  const allowed = input.claims.filter((c) => c.value !== null && (!input.angle || input.angle.proofSources.includes(c.source)));
  const ads = sig ? null : allowed.find((c) => /^signal:[^:]+:active_ads$/.test(c.id)) ?? null;
  const adsText = ads ? `${ads.display} [claim:${ads.id}]` : '';
  const claim = proofClaim(allowed, co, n('claim'), ads?.id ?? null);
  const video = niche ? (en ? `a short ${niche} video` : `un video corto de ${niche}`) : en ? 'a short video' : 'un video corto';
  // Ya trabajaron juntos (una campaña con esta marca en el perfil): se abre con la relación, no como un correo en frío.
  const worked = input.claims.some((c) => c.source === 'campaign_result' && (c.entities ?? []).some((e) => e.toLowerCase() === co.toLowerCase()));
  const t = en
    ? {
        greeting: who ? [`Hi ${who},`, `${who}, hello.`, `Good morning, ${who}.`, `Hello ${who},`] : ['Hi,', 'Hello,'],
        withSignal: [
          `I saw that ${co} ${sig} and started thinking about how I would tell it in ${video}.`,
          `That ${co} ${sig} is exactly the kind of move my audience follows closely.`,
          `It caught my eye that ${co} ${sig}, especially thinking about who buys in ${where}.`,
          `I was looking at the latest from ${co}, and the fact that it ${sig} fits what I publish every week.`,
        ],
        withAds: [
          `I saw ${co} is running ${adsText} active ads right now and started thinking about how I would tell it in ${video}.`,
          `With ${adsText} active ads live, ${co} is talking to a lot of people right now, and I think I can add to that from ${where}.`,
        ],
        together: [
          `After the campaign we did together with ${co}, I kept thinking about what could come next.`,
          `I still have our campaign with ${co} in mind, and I have an idea for the next one.`,
        ],
        togetherSignal: `And I saw it ${sig}, so the timing fits.`,
        noSignal: [
          `I have been following what ${co} does in ${sector} for a while and there is something I want to pitch you.`,
          `Every time ${co} shows up in my feed I think about how my audience in ${where} would use it.`,
          `${co} talks to ${where} in a way that is very close to how I do.`,
        ],
        idea: [
          `I have in mind ${video} where your product fits into my day without feeling like an ad.`,
          `I am picturing a short series that shows the brand in the real routine of the people who watch me, from morning to night.`,
          `I could put together a weekend challenge with your product at the center and my community joining from home.`,
          `I am thinking of a before and after video, told with humor, where your product solves the problem of the day.`,
          `I imagine a format where I answer my followers' questions with your product in hand.`,
        ],
        question: [
          'Would you like me to send you the full idea?',
          'Does it make sense to talk for a few minutes this week?',
          'Who on your team handles creator partnerships?',
          'Would it help if I shared two more concrete video ideas?',
        ],
        subject: [`${co} and a video idea`, `An idea for ${co} in ${where}`, `Your audience and mine in ${where}`, `A video for ${co}`],
      }
    : {
        greeting: who ? [`Hola ${who},`, `${who}, buenas.`, `Buen día, ${who}.`, `Hola, ${who}.`] : ['Hola,', 'Buen día,'],
        withSignal: [
          `Vi que ${co} ${sig} y me quedé pensando en cómo lo contaría en ${video}.`,
          `Que ${co} ${sig} es justo el tipo de movimiento que mi audiencia sigue de cerca.`,
          `Me llamó la atención que ${co} ${sig}, sobre todo pensando en quién compra en ${where}.`,
          `Estuve mirando lo último de ${co}, y que ${sig} encaja con lo que publico cada semana.`,
        ],
        withAds: [
          `Vi que ${co} tiene ${adsText} anuncios activos en este momento y me quedé pensando en cómo lo contaría en ${video}.`,
          `Con ${adsText} anuncios activos, ${co} le está hablando a mucha gente justo ahora, y creo que puedo sumar desde ${where}.`,
        ],
        together: [
          `Después de la campaña que hicimos juntos con ${co}, me quedé pensando en qué podría venir ahora.`,
          `Sigo con buen recuerdo de nuestra campaña con ${co}, y tengo una idea para la siguiente.`,
        ],
        togetherSignal: `Y vi que ${sig}, así que el momento encaja.`,
        noSignal: [
          `Sigo lo que hace ${co} en ${sector} desde hace un tiempo y hay algo que quiero proponerte.`,
          `Cada vez que ${co} aparece en mi feed pienso en cómo lo usaría mi audiencia en ${where}.`,
          `${co} tiene una forma de hablarle a ${where} que se parece mucho a la mía.`,
        ],
        idea: [
          `Se me ocurre ${video} donde su producto entre en mi día a día sin que parezca un anuncio.`,
          `Tengo en mente una serie corta que muestre la marca en la rutina real de quien me ve, de la mañana a la noche.`,
          `Podría armar un reto de fin de semana con su producto como protagonista y la comunidad participando desde casa.`,
          `Pienso en un video de antes y después, contado con humor, donde su producto resuelve el problema del día.`,
          `Me imagino un formato de preguntas de mis seguidores respondidas con su producto en la mano.`,
        ],
        question: [
          '¿Te interesa que te mande la idea completa?',
          '¿Tiene sentido que lo hablemos unos minutos esta semana?',
          '¿Quién en tu equipo ve las colaboraciones con creadores?',
          '¿Te sirve si te comparto dos ideas de video más concretas?',
        ],
        subject: [`${co} y una idea de video`, `Una idea para ${co} en ${where}`, `Tu audiencia y la mía en ${where}`, `Un video para ${co}`],
      };
  return {
    greeting: pick(t.greeting, n('greet')),
    opener: worked
      ? `${pick(t.together, n('open'))}${sig ? ` ${t.togetherSignal}` : ''}`
      : sig ? pick(t.withSignal, n('open')) : ads ? pick(t.withAds, n('open')) : pick(t.noSignal, n('open')),
    proof: claim ? claimSentence(claim, n('proof'), en ? 'en' : 'es', co) : '',
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
        : `${en ? 'Could improve' : 'Mejorable en'}: ${weak.map((d) => RUBRIC_DIMENSION_LABELS[en ? 'en' : 'es'][d]).join(', ')}.`;
      return {
        scores, riskTriggers: [], hint: weak.length === 0 ? null : 'more_specific', note,
        model: FAKE_JUDGE_MODEL, inputTokens: tokensOf(input.body) + 400, outputTokens: 60, costUsd: 0,
      };
    },
  };
}
