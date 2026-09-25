/**
 * El generador de mensajes con afirmaciones trazables (VEN-12, §5.3).
 *
 * Entradas: el perfil comercial con sus claims, la empresa y el contacto,
 * la señal que originó el deal, el paso con su ángulo (lo permitido y lo
 * prohibido), los toques anteriores LEÍDOS SOLO DE LO ENVIADO (status
 * 'sent': Chief escribía «como te comenté el martes» sobre un mensaje que
 * nunca salió), el brief del creador y el idioma. Salida: asunto y cuerpo,
 * con cada cifra marcada [claim:id].
 *
 * El prompt se arma aquí, puro y probado; el modelo va detrás de LlmClient
 * (llm.ts). La regeneración recibe una de las pistas cerradas.
 */
import { readFileSync } from 'node:fs';
import type { ClaimSource, SalesClaim } from './claims.ts';
import { GENERATION_MAX_TOKENS, OUTREACH_MODELS, LlmOutputError, readLlmResponse, type LlmCallOptions, type LlmClient } from './llm.ts';
import { STEP_LENGTH, type RegenerateHint } from './preflight.ts';
import { SUBJECT_MAX_WORDS, SUBJECT_MIN_WORDS } from './gates.ts';

export type GenerationLang = 'es' | 'en';

export interface GenerationAngle {
  key: string;
  label: string;
  goal: string;
  allowed: readonly string[];
  forbidden: readonly string[];
  proof: string | null;
  /** outbound_angle.proof_sources: de dónde puede salir una cifra. Vacío = ninguna. */
  proofSources: readonly ClaimSource[];
}

/** Un toque anterior. Solo entran los ENVIADOS: quien los lee (@mc/db) filtra por status = 'sent'. */
export interface SentTouch {
  stepType: string | null;
  channel: string;
  sentAt: Date;
  subject: string | null;
  body: string;
}

export interface GenerationInput {
  lang: GenerationLang;
  stepType: string;
  dayOffset: number;
  angle: GenerationAngle | null;
  /** outbound_step.guidance_es: la guía del recomendador para este paso. */
  guidance: string | null;
  creator: { name: string; handle: string | null; niche: string | null; bio: string | null };
  company: { name: string; industry: string | null; city: string | null; country: string | null };
  contact: { fullName: string | null; roleTitle: string | null } | null;
  signal: { headline: string; source: string | null; detectedAt: Date | null } | null;
  brief: { title: string; notes: string | null; requiresDisclosure: boolean } | null;
  claims: readonly SalesClaim[];
  previousTouches: readonly SentTouch[];
  /** Mensajes del mismo tipo a otras personas, enviados o por salir: el nuevo no se les tiene que parecer (compuerta B). */
  avoid: readonly string[];
  /** El número de intento (1 el primero) y la pista de la regeneración. */
  attempt: number;
  hint: RegenerateHint | null;
  /** outbound_step_rubric.max_chars del paso, si la hay. */
  maxChars: number | null;
  /**
   * La versión anterior, con sus marcas, cuando se regenera con una pista
   * (la del juez o la que pidió la persona en el editor): «más corto» es
   * más corto que ESTO. null en un primer borrador.
   */
  previousDraft?: string | null;
  /**
   * Lo que la persona pidió en el editor del pitch (el tono, qué destacar),
   * con sus palabras. Orienta; no cambia ninguna regla del prompt.
   */
  instructions?: string | null;
}

export interface GeneratedMessage {
  subject: string | null;
  /** Con sus marcas [claim:id]. */
  body: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MessageGenerator {
  /** Un nombre para el registro y la pantalla («anthropic», «fake»). */
  readonly name: string;
  readonly model: string;
  generate(input: GenerationInput, opts?: LlmCallOptions): Promise<GeneratedMessage>;
}

// ---------------------------------------------------------------------
// Los prompts
// ---------------------------------------------------------------------

const promptCache = new Map<string, string>();

/** Lee un prompt de prompts/*.md (solo en el servidor: el worker). */
export function loadPrompt(name: 'generate' | 'judge' | 'classify'): string {
  let p = promptCache.get(name);
  if (p === undefined) {
    p = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');
    promptCache.set(name, p);
  }
  return p;
}

/** Sustituye los %%nombre%% de un prompt. */
export function fillPrompt(template: string, values: Record<string, string | number>): string {
  return template.replace(/%%([a-z_]+)%%/g, (whole, k: string) => (k in values ? String(values[k]) : whole));
}

/** Lo que pide cada pista cerrada, en palabras para el modelo. */
export const HINT_INSTRUCTIONS: Record<RegenerateHint, string> = {
  shorter: 'La versión anterior era larga. Escribe una más corta: menos frases, la misma idea.',
  more_specific: 'La versión anterior era genérica. Sé más específico con la marca, su señal y su producto.',
  other_angle: 'La versión anterior se parecía demasiado a otros mensajes o se salía del ángulo. Cambia la entrada y la estructura.',
  other_signal: 'Apóyate en otro aspecto de la señal o del momento de la marca.',
  soften: 'La versión anterior sonaba insistente o gritaba. Suaviza el tono, sin presión ni mayúsculas.',
  add_proof: 'La versión anterior tenía cifras sin su marca [claim:ID] o que no coincidían. Usa solo cifras de la lista, con su marca.',
};

function subjectRule(stepType: string): string {
  if (stepType === 'email') {
    return `obligatorio, de ${SUBJECT_MIN_WORDS} a ${SUBJECT_MAX_WORDS} palabras y menos de 80 caracteres, sin «Re:», sin cifras sueltas.`;
  }
  if (stepType === 'email_reply') return 'null: es una respuesta en el mismo hilo y el asunto es «Re:» del anterior.';
  return 'null: este canal no lleva asunto.';
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Un dato de fuera (un titular raspado, la bio, el brief, lo que escribió
 * la persona, un mensaje anterior) entre etiquetas, para que el modelo lo
 * lea como información y nunca como una orden (la regla está en el prompt
 * del sistema). Los «<» y «>» del dato se cambian por comillas angulares:
 * un texto que traiga «</senal>» no puede cerrar la etiqueta y colarse
 * fuera de ella.
 */
export function untrusted(tag: string, value: string, keepLines = false): string {
  const angled = value.replace(/</g, '‹').replace(/>/g, '›');
  const safe = (keepLines ? angled : angled.replace(/\n+/g, ' ')).trim();
  return `<${tag}>${safe}</${tag}>`;
}

/** Las etiquetas con datos de fuera que el prompt del sistema declara como información. */
export const UNTRUSTED_TAGS = [
  'marca', 'sector', 'contacto', 'senal', 'bio_del_creador', 'brief_del_creador', 'instrucciones_del_creador', 'mensaje_anterior',
  'mensaje_a_evitar', 'version_anterior', 'mensaje',
] as const;

/** El sistema y el mensaje del usuario para el generador. Puro: recibe el texto de prompts/generate.md. */
export function buildGenerationPrompt(input: GenerationInput, template: string): { system: string; user: string } {
  const limits = STEP_LENGTH[input.stepType] ?? { min: 1, max: 2000 };
  const system = fillPrompt(template, {
    min_chars: limits.min,
    max_chars: input.maxChars ?? limits.max,
    subject_rule: subjectRule(input.stepType),
  });
  const a = input.angle;
  const lines: string[] = [
    `Idioma: ${input.lang === 'en' ? 'inglés' : 'español'}`,
    `Tipo de paso: ${input.stepType} (día ${input.dayOffset} de la cadencia)`,
    '',
    a
      ? [
          `Ángulo: ${a.label}. ${a.goal}`,
          `Permitido: ${a.allowed.join('; ') || 'lo que pide el ángulo'}`,
          `Prohibido: ${a.forbidden.join('; ') || 'nada adicional'}`,
          `Prueba que puede usar: ${a.proof ?? 'ninguna cifra'}`,
          `Orígenes permitidos: ${a.proofSources.join(', ') || 'ninguno'}`,
        ].join('\n')
      : 'Ángulo: libre, sin cifras que no estén en la lista.',
    input.guidance ? `Guía del paso: ${input.guidance}` : '',
    '',
    `Creador: ${input.creator.name}${input.creator.handle ? ` (@${input.creator.handle.replace(/^@/, '')})` : ''}` +
      `${input.creator.niche ? `, nicho ${input.creator.niche}` : ''}`,
    input.creator.bio ? `Cómo se presenta: ${untrusted('bio_del_creador', input.creator.bio)}` : '',
    `Marca: ${untrusted('marca', input.company.name)}${input.company.industry ? `, sector ${untrusted('sector', input.company.industry)}` : ''}` +
      `${input.company.city ? `, ${input.company.city}` : ''}${input.company.country ? ` (${input.company.country})` : ''}`,
    input.contact?.fullName
      ? `Contacto: ${untrusted('contacto', `${input.contact.fullName}${input.contact.roleTitle ? `, ${input.contact.roleTitle}` : ''}`)}`
      : 'Contacto: sin nombre',
    input.signal
      ? `Señal: ${untrusted('senal', input.signal.headline)}${input.signal.detectedAt ? ` (detectada el ${dateOnly(input.signal.detectedAt)})` : ''}`
      : 'Señal: ninguna registrada; apóyate en la marca y su sector.',
    input.brief
      ? `Brief del creador: ${untrusted('brief_del_creador', `${input.brief.title}${input.brief.notes ? `. ${input.brief.notes}` : ''}`)}` +
        `${input.brief.requiresDisclosure ? '. Exige divulgar las colaboraciones pagadas.' : ''}`
      : '',
    '',
    'Afirmaciones que puedes citar (ID · qué es · se escribe · origen):',
    ...(input.claims.length > 0
      ? input.claims.map((c) => `- ${c.id} · ${c.label} · ${c.display} · ${c.source}`)
      : ['- (ninguna: no escribas cifras)']),
    '',
    'Mensajes enviados antes a esta persona (solo los que salieron):',
    ...(input.previousTouches.length > 0
      ? input.previousTouches.map(
          (t) => `- ${dateOnly(t.sentAt)} · ${t.stepType ?? t.channel}\n  ${untrusted('mensaje_anterior', `${t.subject ? `Asunto: ${t.subject}. ` : ''}${t.body}`)}`,
        )
      : ['- (ninguno: este es el primero)']),
  ];
  if (input.avoid.length > 0) {
    lines.push('', 'No te parezcas a estos (a otras marcas, enviados o por salir):', ...input.avoid.map((b) => `- ${untrusted('mensaje_a_evitar', b)}`));
  }
  if (input.instructions?.trim()) {
    lines.push('', `Lo que pide el creador para este mensaje (orienta el tono y el foco; las reglas no cambian): ${untrusted('instrucciones_del_creador', input.instructions)}`);
  }
  if (input.hint) {
    if (input.previousDraft?.trim()) lines.push('', 'Versión anterior (no la repitas):', untrusted('version_anterior', input.previousDraft, true));
    lines.push('', `Pista de esta versión (intento ${input.attempt}): ${HINT_INSTRUCTIONS[input.hint]}`);
  }
  return { system, user: lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n').trim() };
}

/** El JSON Schema de la salida del generador. */
export const GENERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    body: { type: 'string' },
  },
  required: ['subject', 'body'],
  additionalProperties: false,
};

/** Lee {subject, body} de la respuesta del modelo. */
export function parseGeneration(value: unknown): { subject: string | null; body: string } {
  if (!value || typeof value !== 'object') throw new LlmOutputError('La respuesta del generador no es un objeto.', null);
  const v = value as Record<string, unknown>;
  if (typeof v.body !== 'string' || !v.body.trim()) throw new LlmOutputError('La respuesta del generador no trae cuerpo.', null);
  const subject = typeof v.subject === 'string' && v.subject.trim() ? v.subject.trim() : null;
  return { subject, body: v.body.trim() };
}

/** El generador sobre un modelo de lenguaje (Anthropic en producción). */
export class LlmMessageGenerator implements MessageGenerator {
  readonly name: string;
  readonly model: string;
  readonly #llm: LlmClient;
  readonly #template: string;

  constructor(llm: LlmClient, opts: { model?: string; template?: string } = {}) {
    this.#llm = llm;
    this.name = llm.name;
    this.model = opts.model ?? OUTREACH_MODELS.generate;
    this.#template = opts.template ?? loadPrompt('generate');
  }

  async generate(input: GenerationInput, opts?: LlmCallOptions): Promise<GeneratedMessage> {
    const { system, user } = buildGenerationPrompt(input, this.#template);
    const res = await this.#llm.complete({
      purpose: 'generate', model: this.model, system, user,
      maxTokens: GENERATION_MAX_TOKENS[input.stepType] ?? 600, jsonSchema: GENERATION_SCHEMA,
    }, opts);
    const out = readLlmResponse(res, parseGeneration);
    return { ...out, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd };
  }
}
