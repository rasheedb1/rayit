/**
 * El recomendador de cadencia (VEN-13, docs/ventas-outreach.md §5.5).
 *
 * Recibe el tipo de señal que originó el negocio, los nichos del
 * creador, los canales que tiene conectados (y los que la política del
 * espacio deja usar), las direcciones del contacto al que se le va a
 * escribir y si el brief pide divulgación; devuelve una secuencia
 * propuesta: pasos con día, canal, ángulo y una guía por paso («abre
 * con…, no menciones…, cierra con…»).
 *
 * Reglas deterministas primero, en este orden:
 *   1. La plantilla: la de su tipo de señal y su nicho; si no hay, la de
 *      su señal para cualquier nicho; si tampoco, una genérica
 *      (signal_kind NULL). Nunca la de otra señal u otro nicho.
 *   2. El canal de cada paso: el de la plantilla si llega; si no, el
 *      siguiente que llegue, en un orden fijo por tipo de paso (un
 *      directo prueba LinkedIn, Instagram y el correo; un correo prueba
 *      LinkedIn e Instagram; un gesto público prueba la otra red y, si
 *      ninguna está, queda como tarea a mano). «Llega» es: la política
 *      lo deja, hay una cuenta conectada (aunque esté por reconectar) y,
 *      si el paso le escribe a la persona, la persona tiene dirección en
 *      ese canal. El hilo de correo sigue normalizeThread (thread.ts),
 *      la misma regla que la línea de tiempo editable: el primer correo
 *      abre el hilo y los siguientes responden, salvo el cierre.
 *   3. La política del espacio (outbound_policy): la propuesta nace
 *      cumpliéndola, no con avisos. Si hay más mensajes que
 *      max_touches_per_company, los del medio (prueba social, luego el
 *      concepto, luego la prueba de desempeño) se vuelven un gesto
 *      público en la red (una reacción, que no es un mensaje y no cuenta
 *      para el tope) o, si no hay red, se quitan; el primero y la
 *      síntesis se quedan siempre. Después los días se estiran para que
 *      entre dos mensajes haya min_days_between_touches, sin pasar del
 *      día MAX_DAY_OFFSET. checkSequenceAgainstPolicy de la propuesta
 *      queda vacío; lo cambiado va en una nota (fitted_to_policy).
 *   4. La guía: la de la plantilla si el paso quedó como estaba; si
 *      cambió de canal, se compone con el ángulo, el canal y la señal
 *      (una guía de correo en un directo de LinkedIn mentiría). La
 *      divulgación del brief se añade al cierre.
 *
 * El modelo (claude-sonnet-5) solo REDACTA la guía, y solo cuando hay
 * llave: refineGuidance recibe un redactor (GuidanceWriter) detrás de una
 * interfaz, valida lo que devuelve paso a paso y se queda con la regla
 * donde el texto no sirve. Los días, canales y ángulos no los toca.
 *
 * Todo lo que el recomendador explica va en códigos (ProposalNote): la
 * pantalla los traduce en su messages.ts.
 */
import type { LlmUsage } from './llm-cost.ts';
import { findPlaceholders } from './placeholder-guard.ts';
import { GUIDANCE_PHRASES, type GuidanceLocale } from './guidance-phrases.ts';
import {
  RECOMMEND_CHANNELS, type ProposalNote, type RecommendChannel, type RecommendSignalKind, type RerouteReason,
} from './proposal-notes.ts';
import { DISPATCHABLE_STEP_TYPES, type SequencePolicy } from './sequence-policy.ts';
import { normalizeThread } from './thread.ts';

/** El último día al que se puede poner un paso (CHECK de outbound_step.day_offset, 0037). */
export const SEQUENCE_MAX_DAY_OFFSET = 60;

// Los tipos de señal, los canales, los motivos de cambio de canal y las
// notas (ProposalNote) viven en proposal-notes.ts, con su esquema zod.

/**
 * El tipo de señal de una fuente del radar (signal_source.kind, 0007):
 * anuncios activos, marketplace de creadores y vacantes de influencer
 * marketing son una marca que ya está invirtiendo (campaña activa); la
 * prensa trae lanzamientos; una colaboración vista en una cuenta vigilada
 * es la de un competidor; lo demás, manual.
 */
export function signalKindOfSource(sourceKind: string | null | undefined): RecommendSignalKind {
  switch (sourceKind) {
    case 'ads':
    case 'marketplace':
    case 'jobs':
      return 'active_campaign';
    case 'press':
      return 'launch';
    case 'season':
      return 'season';
    case 'collab':
      return 'collab';
    default:
      return 'manual';
  }
}

/** Un paso de una plantilla, como viene del jsonb de outbound_sequence_template.steps. */
export interface RecommendTemplateStep {
  day_offset: number;
  order_in_day: number;
  step_type: string;
  channel: string;
  angle_key: string | null;
  scheduled_time: string;
  generate_with_ai: boolean;
  requires_asset: 'media_kit' | 'quote' | null;
  guidance_es: string;
}

export interface RecommendTemplate {
  slug: string;
  nameEs: string;
  signalKind: string | null;
  nicheSlug: string | null;
  steps: readonly RecommendTemplateStep[];
}

/**
 * El estado de un canal para el recomendador: conectado; caído (la
 * cuenta existe pero pide reconectar: se planea igual y se avisa);
 * ausente (ninguna cuenta).
 */
export type ChannelState = 'connected' | 'down' | 'missing';

/** Qué direcciones tiene la persona a la que se le va a escribir. */
export interface ContactReach {
  hasEmail: boolean;
  hasLinkedin: boolean;
  hasInstagram: boolean;
}

export interface RecommendInput {
  signalKind: RecommendSignalKind;
  /** Los nichos del creador (creator_profile.niche_slugs). */
  nicheSlugs: readonly string[];
  channels: Readonly<Record<RecommendChannel, ChannelState>>;
  /** outbound_policy.allowed_channels: lo que no esté aquí no se usa aunque esté conectado. */
  allowedChannels: readonly string[];
  /** La persona elegida. null = todavía no hay nadie: se planea como si tuviera todas las direcciones. */
  contact: ContactReach | null;
  /** outbound_brief.requires_disclosure del brief activo. */
  requiresDisclosure: boolean;
  /** Las plantillas activas. */
  templates: readonly RecommendTemplate[];
  /** outbound_policy del espacio: tope de mensajes a una marca y días entre ellos. */
  policy: SequencePolicy;
  /**
   * El idioma de las frases de la guía compuesta (guidance-phrases.ts);
   * quien llama lo saca del locale del espacio con guidanceLocale. Sin
   * él, español: lo que hacían siempre las plantillas.
   */
  locale?: GuidanceLocale;
}

export interface ProposedStep {
  dayOffset: number;
  orderInDay: number;
  stepType: string;
  channel: string;
  angleKey: string | null;
  /** 'HH:MM', hora local de la secuencia. */
  scheduledTime: string;
  generateWithAi: boolean;
  requiresAsset: 'media_kit' | 'quote' | null;
  guidanceEs: string;
  /**
   * Quién escribió la guía: la plantilla tal cual, las reglas (compuesta
   * porque el paso cambió) o el modelo. Se guarda con el paso
   * (outbound_step.guidance_source): si el paso cambia de tipo después,
   * la de la plantilla, las reglas o el modelo se recompone, y la que
   * escribió la persona se queda (guidanceAfterRetype).
   */
  guidanceSource: Exclude<GuidanceSource, 'person'>;
  /** Lo que decía la plantilla, si el recomendador lo cambió. */
  changedFrom: { stepType: string; channel: string } | null;
}

/** Quién escribió la guía de un paso (outbound_step.guidance_source, 0056). */
export const GUIDANCE_SOURCES = ['template', 'rules', 'llm', 'person'] as const;
export type GuidanceSource = (typeof GUIDANCE_SOURCES)[number];

export interface Proposal {
  templateSlug: string;
  templateName: string;
  signalKind: RecommendSignalKind;
  steps: ProposedStep[];
  notes: ProposalNote[];
  /** El canal que más pasos lleva: outbound_sequence.channel. */
  primaryChannel: RecommendChannel;
}

export class RecommendError extends Error {
  readonly code: 'no_template' | 'empty_template';
  constructor(code: 'no_template' | 'empty_template') {
    super(code === 'no_template' ? 'No hay ninguna plantilla para esta señal.' : 'La plantilla no tiene pasos.');
    this.name = 'RecommendError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// 1 · La plantilla
// ---------------------------------------------------------------------

/**
 * La plantilla para una señal y unos nichos: señal y nicho > señal >
 * genérica. A igualdad, la primera de la lista (quien llama la ordena).
 */
export function chooseTemplate(
  templates: readonly RecommendTemplate[],
  kind: RecommendSignalKind,
  nicheSlugs: readonly string[],
): { template: RecommendTemplate; match: 'niche_and_signal' | 'signal' | 'generic' } | null {
  let best: { template: RecommendTemplate; score: number } | null = null;
  for (const t of templates) {
    if (t.signalKind !== null && t.signalKind !== kind) continue;
    if (t.nicheSlug !== null && !nicheSlugs.includes(t.nicheSlug)) continue;
    const score = (t.signalKind === kind ? 4 : 1) + (t.nicheSlug !== null ? 2 : 0);
    if (!best || score > best.score) best = { template: t, score };
  }
  if (!best) return null;
  const match = best.score >= 6 ? 'niche_and_signal' : best.score >= 4 ? 'signal' : 'generic';
  return { template: best.template, match };
}

// ---------------------------------------------------------------------
// 2 · El canal de cada paso
// ---------------------------------------------------------------------

type StepFamily = 'direct' | 'email' | 'public_comment' | 'public_like' | 'manual';

function familyOf(stepType: string): StepFamily {
  if (stepType === 'email' || stepType === 'email_reply') return 'email';
  if (stepType === 'linkedin_comment' || stepType === 'instagram_comment') return 'public_comment';
  if (stepType === 'linkedin_like' || stepType === 'instagram_like') return 'public_like';
  if (stepType === 'manual_task') return 'manual';
  return 'direct';
}

/** En qué orden se prueban los canales de cada familia de paso. El del paso va primero. */
function candidatesFor(family: StepFamily, original: string): string[] {
  const order: Record<Exclude<StepFamily, 'manual'>, string[]> = {
    direct: ['linkedin', 'instagram_dm', 'email'],
    email: ['email', 'linkedin', 'instagram_dm'],
    public_comment: ['linkedin', 'instagram_dm'],
    public_like: ['linkedin', 'instagram_dm'],
  };
  if (family === 'manual') return [original];
  return [original, ...order[family].filter((c) => c !== original)];
}

/** El tipo de paso de una familia en un canal. `emailSeen`: ya hay un correo antes en la secuencia. */
function stepTypeFor(family: StepFamily, channel: string, originalType: string, emailSeen: boolean): string {
  if (channel === 'email') return emailSeen ? 'email_reply' : 'email';
  if (family === 'public_comment') return channel === 'linkedin' ? 'linkedin_comment' : 'instagram_comment';
  if (family === 'public_like') return channel === 'linkedin' ? 'linkedin_like' : 'instagram_like';
  if (channel === 'linkedin') return originalType === 'linkedin_connect' ? 'linkedin_connect' : 'linkedin_message';
  return 'instagram_dm';
}

function hasAddress(contact: ContactReach, channel: string): boolean {
  if (channel === 'email') return contact.hasEmail;
  if (channel === 'linkedin') return contact.hasLinkedin;
  if (channel === 'instagram_dm') return contact.hasInstagram;
  return false;
}

/** Por qué un canal no sirve para este paso, o null si sirve. */
function blockerFor(input: Pick<RecommendInput, 'allowedChannels' | 'channels' | 'contact'>, channel: string, needsAddress: boolean): RerouteReason | null {
  if (!(RECOMMEND_CHANNELS as readonly string[]).includes(channel) || !input.allowedChannels.includes(channel)) {
    return 'channel_not_allowed';
  }
  if (input.channels[channel as RecommendChannel] === 'missing') return 'channel_not_connected';
  if (needsAddress && input.contact && !hasAddress(input.contact, channel)) return 'contact_has_no_address';
  return null;
}

// ---------------------------------------------------------------------
// 3 · La guía compuesta
// ---------------------------------------------------------------------

/** La frase de divulgación en español (GUIDANCE_PHRASES.es.disclosure), para quien la busca por nombre. */
export const DISCLOSURE_GUIDANCE = GUIDANCE_PHRASES.es.disclosure;

/**
 * La guía de un paso compuesta con reglas: canal + ángulo + señal, con
 * las frases del idioma `locale` (guidance-phrases.ts). Es la que queda
 * cuando el paso cambió de canal o cuando el modelo no da una que sirva.
 */
export function composeGuidance(
  angleKey: string | null, stepType: string, signalKind: RecommendSignalKind, locale: GuidanceLocale = 'es',
): string {
  const t = GUIDANCE_PHRASES[locale];
  const signal = t.signal[signalKind];
  const opening = (angleKey && t.angleOpening[angleKey]?.(signal)) || t.genericOpening(signal);
  const forbidden = (angleKey && t.angleForbidden[angleKey]) || t.genericForbidden;
  const collab = signalKind === 'collab' ? ` ${t.collabForbidden}` : '';
  const family = familyOf(stepType);
  let lead: string;
  let close = ` ${t.closeWithQuestion}`;
  if (family === 'public_comment') {
    lead = t.lead.publicComment(opening);
    close = '';
  } else if (family === 'public_like' || family === 'manual') {
    lead = t.lead.byHand(opening);
    close = '';
  } else if (stepType === 'email_reply') {
    lead = t.lead.reply(opening);
  } else if (stepType === 'linkedin_connect') {
    lead = t.lead.connectNote(opening);
    close = '';
  } else if (family === 'direct') {
    lead = t.lead.direct(opening);
  } else {
    lead = t.lead.email(opening);
  }
  if (angleKey === 'sintesis') close = '';
  return `${lead} ${forbidden}${collab}${close}`;
}

/**
 * La guía compuesta de un paso con la divulgación del brief en el cierre:
 * la que la línea de tiempo pone al añadir un paso, al cambiarle el
 * ángulo o al cambiarle el tipo (si no la escribió la persona).
 */
export function composeStepGuidance(
  angleKey: string | null,
  stepType: string,
  ctx: { signalKind: RecommendSignalKind; locale?: GuidanceLocale; requiresDisclosure: boolean },
): string {
  return withDisclosure(composeGuidance(angleKey, stepType, ctx.signalKind, ctx.locale), angleKey, ctx.requiresDisclosure, ctx.locale);
}

function withDisclosure(guidance: string, angleKey: string | null, requires: boolean, locale: GuidanceLocale = 'es'): string {
  const disclosure = GUIDANCE_PHRASES[locale].disclosure;
  if (!requires || angleKey !== 'sintesis' || guidance.includes(disclosure)) return guidance;
  return `${guidance} ${disclosure}`;
}

// ---------------------------------------------------------------------
// 4 · La propuesta
// ---------------------------------------------------------------------

/** Propone una secuencia. Pura y determinista: la misma entrada da la misma salida. */
export function recommendSequence(input: RecommendInput): Proposal {
  const chosen = chooseTemplate(input.templates, input.signalKind, input.nicheSlugs);
  if (!chosen) throw new RecommendError('no_template');
  const { template, match } = chosen;
  if (template.steps.length === 0) throw new RecommendError('empty_template');
  const locale = input.locale ?? 'es';

  const notes: ProposalNote[] = [{ code: 'template', slug: template.slug, match }];
  if (!input.contact) notes.push({ code: 'no_contact' });

  const ordered = [...template.steps].sort((a, b) => a.day_offset - b.day_offset || a.order_in_day - b.order_in_day);
  const routed: ProposedStep[] = [];
  let emailSeen = false;

  ordered.forEach((s, i) => {
    const family = familyOf(s.step_type);
    const needsAddress = family === 'direct' || family === 'email';
    let channel = s.channel;
    let stepType = s.step_type;

    if (family !== 'manual') {
      const reason = blockerFor(input, s.channel, needsAddress);
      if (reason) {
        const next = candidatesFor(family, s.channel).slice(1).find((c) => blockerFor(input, c, needsAddress) === null);
        if (next) {
          channel = next;
          stepType = stepTypeFor(family, next, s.step_type, emailSeen);
          notes.push({ code: 'rerouted', step: i + 1, from: s.channel, to: next, manual: false, reason });
        } else if (family === 'public_comment' || family === 'public_like') {
          // Un gesto público no le escribe a nadie: si ninguna red está, lo hace la persona a mano.
          stepType = 'manual_task';
          notes.push({ code: 'rerouted', step: i + 1, from: s.channel, to: s.channel, manual: true, reason });
        } else {
          notes.push({ code: 'unreachable', step: i + 1, channel: s.channel });
        }
      }
    }
    if (channel === 'email') emailSeen = true;

    const changed = stepType !== s.step_type || channel !== s.channel;
    routed.push({
      dayOffset: s.day_offset,
      orderInDay: s.order_in_day,
      stepType,
      channel,
      angleKey: s.angle_key,
      scheduledTime: s.scheduled_time,
      generateWithAi: s.generate_with_ai,
      requiresAsset: s.requires_asset,
      guidanceEs: changed ? composeGuidance(s.angle_key, stepType, input.signalKind, locale) : s.guidance_es,
      guidanceSource: changed ? 'rules' : 'template',
      changedFrom: changed ? { stepType: s.step_type, channel: s.channel } : null,
    });
  });

  const fitted = fitToPolicy(routed, input);
  if (fitted.note) {
    // Las notas de canal hablan del paso por su número: el de la propuesta final. La de un paso que
    // pasó a gesto o se quitó ya no dice la verdad, y la explica la nota de la política.
    const position = new Map(fitted.origins.map((o, k) => [o + 1, k + 1]));
    const kept = notes.filter((n) => !('step' in n) || (!fitted.sacrificed.has(n.step - 1) && position.has(n.step)));
    notes.length = 0;
    notes.push(...kept.map((n) => ('step' in n ? { ...n, step: position.get(n.step)! } : n)), fitted.note);
  }
  const steps = openThread(fitted.steps, input.signalKind, locale).map((s) => ({
    ...s,
    guidanceEs: withDisclosure(s.guidanceEs, s.angleKey, input.requiresDisclosure, locale),
  }));

  if (input.requiresDisclosure && steps.some((s) => s.angleKey === 'sintesis')) notes.push({ code: 'disclosure' });
  for (const c of RECOMMEND_CHANNELS) {
    if (input.channels[c] === 'down' && steps.some((s) => s.channel === c && s.stepType !== 'manual_task')) {
      notes.push({ code: 'channel_down', channel: c });
    }
  }

  return {
    templateSlug: template.slug,
    templateName: template.nameEs,
    signalKind: input.signalKind,
    steps,
    notes,
    primaryChannel: primaryChannelOf(steps),
  };
}

/**
 * El hilo de correo (normalizeThread, thread.ts): el primer correo lo
 * abre y los siguientes responden en él, salvo el cierre que la
 * plantilla pide como hilo nuevo. Corre después de ajustar a la
 * política, porque quitar un paso puede dejar una respuesta como primer
 * correo. Un paso que cambia de tipo lleva la guía de su tipo nuevo.
 */
function openThread(steps: readonly ProposedStep[], signalKind: RecommendSignalKind, locale: GuidanceLocale): ProposedStep[] {
  const types = normalizeThread(steps);
  return steps.map((s, i) => {
    const stepType = types[i]!;
    if (stepType === s.stepType) return s;
    return {
      ...s,
      stepType,
      guidanceEs: composeGuidance(s.angleKey, stepType, signalKind, locale),
      guidanceSource: 'rules',
      changedFrom: s.changedFrom ?? { stepType: s.stepType, channel: s.channel },
    };
  });
}

/** La guía de un paso: quién la escribió y para qué tipo de paso (outbound_step, 0056). */
export interface StepGuidance {
  guidance: string | null;
  /** null: una fila anterior a 0056, que no se sabe; se trata como de la persona (no se pisa). */
  source: GuidanceSource | null;
  /** El tipo de paso para el que se escribió (outbound_step.guidance_for_type). */
  writtenFor: string | null;
}

/**
 * La guía de un paso que pasa a `stepType` (se reordenó, se quitó otro
 * paso o se le cambió el tipo). La que salió de la plantilla, de las
 * reglas o del modelo se recompone para el tipo nuevo: una guía de
 * «Responde en el mismo hilo» en el correo que abre el hilo, o una de
 * correo en un directo de LinkedIn, le daría al generador (VEN-12) una
 * orden imposible. La que escribió la persona no se toca: queda marcada
 * (guidanceIsStale) para que la revise.
 */
export function guidanceAfterRetype(
  current: StepGuidance & { angleKey: string | null },
  stepType: string,
  ctx: { signalKind: RecommendSignalKind; locale?: GuidanceLocale; requiresDisclosure: boolean },
): StepGuidance {
  const { guidance, source, writtenFor } = current;
  if (writtenFor === stepType) return { guidance, source, writtenFor };
  if (guidance === null) return { guidance: null, source, writtenFor: stepType };
  if (source === 'person' || source === null) return { guidance, source, writtenFor };
  return {
    guidance: composeStepGuidance(current.angleKey, stepType, ctx),
    source: 'rules',
    writtenFor: stepType,
  };
}

/** La guía se escribió para otro tipo de paso y nadie la ha revisado desde entonces. */
export function guidanceIsStale(g: Pick<StepGuidance, 'guidance' | 'writtenFor'>, stepType: string): boolean {
  return g.guidance !== null && g.writtenFor !== null && g.writtenFor !== stepType;
}

// ---------------------------------------------------------------------
// 5 · La propuesta, ajustada a la política del espacio
// ---------------------------------------------------------------------

/**
 * En qué orden se sacrifican los mensajes del medio cuando pasan del
 * tope: primero el que menos aporta a la venta (la prueba social repite
 * lo que ya dijo la de desempeño), luego el concepto creativo, luego la
 * prueba de desempeño. El primer mensaje (abre la conversación) y la
 * síntesis (media kit y cotización: el que vende) no se tocan.
 */
export const POLICY_DROP_ORDER = ['prueba_social', 'concepto_creativo', 'prueba_desempeno', 'encaje_audiencia', 'presencia'] as const;

function isDispatchable(stepType: string): boolean {
  return (DISPATCHABLE_STEP_TYPES as readonly string[]).includes(stepType);
}

function dropRank(angle: string | null): number {
  if (angle === 'sintesis') return POLICY_DROP_ORDER.length + 1;
  const r = (POLICY_DROP_ORDER as readonly string[]).indexOf(angle ?? '');
  return r < 0 ? POLICY_DROP_ORDER.length : r;
}

/**
 * El mensaje que se sacrifica ahora, o -1 si no queda ninguno. Nunca el
 * primer mensaje; la síntesis solo si el tope no deja ni dos mensajes.
 * A igualdad de ángulo, el más tardío.
 */
function nextVictim(steps: readonly ProposedStep[], cap: number): number {
  const sendable = steps.map((s, i) => ({ s, i })).filter((x) => isDispatchable(x.s.stepType));
  const candidates = sendable.slice(1).filter((x) => cap < 2 || x.s.angleKey !== 'sintesis');
  let best: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const cmp = best ? dropRank(c.s.angleKey) - dropRank(best.s.angleKey) : -1;
    if (!best || cmp < 0 || (cmp === 0 && c.i > best.i)) best = c;
  }
  return best ? best.i : -1;
}

/**
 * El mensaje sacrificado pasa a gesto público (una reacción en su red o
 * en la primera que llegue): la marca sigue viendo a la creadora ese día
 * sin que cuente como mensaje. Sin red disponible, null: se quita.
 */
function softenToGesture(s: ProposedStep, input: FitInput): ProposedStep | null {
  const own = s.channel === 'linkedin' || s.channel === 'instagram_dm' ? [s.channel] : [];
  const network = [...own, 'linkedin', 'instagram_dm'].find((c) => blockerFor(input, c, false) === null);
  if (!network) return null;
  const stepType = network === 'linkedin' ? 'linkedin_like' : 'instagram_like';
  return {
    ...s,
    stepType,
    channel: network,
    angleKey: 'presencia',
    generateWithAi: false,
    requiresAsset: null,
    guidanceEs: composeGuidance('presencia', stepType, input.signalKind, input.locale),
    guidanceSource: 'rules',
    changedFrom: s.changedFrom ?? { stepType: s.stepType, channel: s.channel },
  };
}

/**
 * Corre los días para que entre dos mensajes haya `minDays`. Lo que va
 * detrás de un mensaje corrido se corre lo mismo (un gesto conserva su
 * distancia con el mensaje de antes). Dentro de cada día, el orden vuelve
 * a ser 0, 1, 2…
 */
function stretchDays(steps: readonly ProposedStep[], minDays: number): { steps: ProposedStep[]; shift: number } {
  let shift = 0;
  let prevSend: number | null = null;
  const moved = steps.map((s) => {
    let day = s.dayOffset + shift;
    if (isDispatchable(s.stepType)) {
      if (prevSend !== null && day - prevSend < minDays) {
        shift += prevSend + minDays - day;
        day = prevSend + minDays;
      }
      prevSend = day;
    }
    return { ...s, dayOffset: Math.min(day, SEQUENCE_MAX_DAY_OFFSET), wanted: day };
  });
  const perDay = new Map<number, number>();
  const out = moved.map(({ wanted: _wanted, ...s }) => {
    const n = perDay.get(s.dayOffset) ?? 0;
    perDay.set(s.dayOffset, n + 1);
    return { ...s, orderInDay: n };
  });
  return { steps: out, shift: moved.some((s) => s.wanted > SEQUENCE_MAX_DAY_OFFSET) ? Infinity : shift };
}

type FitInput = Pick<RecommendInput, 'policy' | 'channels' | 'allowedChannels' | 'contact' | 'signalKind' | 'locale'>;

/**
 * Ajusta los pasos a la política (el paso 3 del encabezado). Exportada
 * para probarla sola; recommendSequence la llama siempre.
 */
export function fitToPolicy(
  routed: readonly ProposedStep[],
  input: FitInput,
): FitResult {
  const cap = Math.floor(input.policy.maxTouchesPerCompany);
  const minDays = Math.max(0, Math.floor(input.policy.minDaysBetweenTouches));
  let steps = [...routed];
  let origins = routed.map((_, i) => i);
  const sacrificed = new Set<number>();
  const softened: string[] = [];
  const dropped: string[] = [];

  const sacrifice = (): boolean => {
    const i = nextVictim(steps, cap);
    if (i < 0) return false;
    const victim = steps[i]!;
    const gesture = softenToGesture(victim, input);
    (gesture ? softened : dropped).push(victim.angleKey ?? victim.stepType);
    sacrificed.add(origins[i]!);
    if (gesture) {
      steps = steps.map((s, k) => (k === i ? gesture : s));
    } else {
      steps = steps.filter((_, k) => k !== i);
      origins = origins.filter((_, k) => k !== i);
    }
    return true;
  };

  // Un tope de 0 no deja salir nada: ninguna propuesta lo cumple, y la pantalla ya lo avisa.
  if (cap >= 1) {
    while (steps.filter((s) => isDispatchable(s.stepType)).length > cap && sacrifice()) {
      // de uno en uno, en el orden de POLICY_DROP_ORDER
    }
  }
  let stretched = stretchDays(steps, minDays);
  // Si estirar pasa del último día, se sacrifica otro mensaje del medio; sin ninguno, se queda en el último día.
  while (stretched.shift === Infinity && sacrifice()) stretched = stretchDays(steps, minDays);

  const moved = stretched.steps.some((s, i) => s.dayOffset !== steps[i]!.dayOffset);
  if (sacrificed.size === 0 && !moved) return { steps: [...routed], note: null, origins: routed.map((_, i) => i), sacrificed };
  const shiftedDays = Math.max(0, (stretched.steps.at(-1)?.dayOffset ?? 0) - (routed.at(-1)?.dayOffset ?? 0));
  return {
    steps: stretched.steps,
    note: { code: 'fitted_to_policy', softened, dropped, shiftedDays, maxTouches: cap, minDays },
    origins,
    sacrificed,
  };
}

/**
 * Lo que devuelve fitToPolicy. `origins[k]`: de qué paso de la entrada
 * sale el paso k; `sacrificed`: los pasos de la entrada que pasaron a
 * gesto o se quitaron (sus notas de canal ya no dicen la verdad).
 */
export interface FitResult {
  steps: ProposedStep[];
  note: Extract<ProposalNote, { code: 'fitted_to_policy' }> | null;
  origins: number[];
  sacrificed: ReadonlySet<number>;
}

/** El canal con más pasos que le escriben a la persona; a igualdad, el correo. */
export function primaryChannelOf(steps: ReadonlyArray<{ channel: string; stepType: string }>): RecommendChannel {
  const count = new Map<string, number>();
  for (const s of steps) {
    if (s.stepType === 'manual_task') continue;
    count.set(s.channel, (count.get(s.channel) ?? 0) + 1);
  }
  let best: RecommendChannel = 'email';
  for (const c of RECOMMEND_CHANNELS) if ((count.get(c) ?? 0) > (count.get(best) ?? 0)) best = c;
  return best;
}

// ---------------------------------------------------------------------
// 6 · La guía redactada por el modelo
// ---------------------------------------------------------------------

/** El modelo que redacta la guía (docs/ventas-outreach.md §5: sonnet genera y juzga). */
export const RECOMMEND_MODEL = 'claude-sonnet-5';
export const GUIDANCE_MIN_CHARS = 20;
export const GUIDANCE_MAX_CHARS = 400;

/** Lo que el redactor sabe de cada paso: el paso decidido y la guía de reglas como borrador. */
export interface GuidanceRequestStep {
  index: number;
  dayOffset: number;
  stepType: string;
  channel: string;
  angleKey: string | null;
  angleLabel: string | null;
  /** outbound_angle.forbidden_es del ángulo. */
  forbidden: readonly string[];
  draft: string;
}

/**
 * Lo que se le manda al redactor. Nada de la persona a la que se escribe
 * (ni su nombre ni sus direcciones): la guía es para el paso, no para
 * ella, y así no sale ningún dato personal hacia el proveedor.
 */
export interface GuidanceRequest {
  signalKind: RecommendSignalKind;
  /**
   * El idioma en que se escribe la guía: el mismo de las frases de la
   * guía compuesta (guidanceLocale del espacio), para que ningún paso
   * quede en otro idioma que sus vecinos.
   */
  locale: GuidanceLocale;
  signalHeadline: string | null;
  companyName: string | null;
  briefTitle: string | null;
  briefNotes: string | null;
  requiresDisclosure: boolean;
  steps: GuidanceRequestStep[];
}

/**
 * Lo que devuelve el redactor. Si la API respondió pero el texto no se
 * pudo leer, `steps` va vacío y `usage` va igual: la llamada se cobró y
 * tiene que quedar en outbound_llm_call.
 */
export interface GuidanceWriterResult {
  steps: Array<{ index: number; guidance: string }>;
  usage: LlmUsage;
}

export type GuidanceWriter = (req: GuidanceRequest) => Promise<GuidanceWriterResult>;

/** Por qué una guía del modelo no sirve, o null si sirve. */
export function guidanceProblem(text: string): 'too_short' | 'too_long' | 'placeholders' | null {
  const t = text.trim();
  if ([...t].length < GUIDANCE_MIN_CHARS) return 'too_short';
  if ([...t].length > GUIDANCE_MAX_CHARS) return 'too_long';
  if (findPlaceholders(t).length > 0) return 'placeholders';
  return null;
}

export interface RefineResult {
  proposal: Proposal;
  /** 'llm' si al menos un paso quedó con la guía del modelo. */
  source: 'llm' | 'rules';
  /** La llamada que hay que registrar (null si no hubo). */
  usage: LlmUsage | null;
  /** Cuántos pasos se quedaron con la guía de reglas porque la del modelo no servía o no llegó. */
  keptRules: number;
  /** El redactor lanzó (red, API caída): todo queda con reglas. */
  failed: boolean;
}

/**
 * Pide al redactor la guía de cada paso y se queda con la que sirve.
 * Los días, los canales y los ángulos no cambian; la divulgación del
 * brief se vuelve a añadir aunque el modelo la haya olvidado.
 */
export async function refineGuidance(
  proposal: Proposal,
  ctx: Omit<GuidanceRequest, 'steps' | 'signalKind' | 'requiresDisclosure' | 'locale'> & {
    requiresDisclosure: boolean;
    angles: Readonly<Record<string, { label: string; forbidden: readonly string[] }>>;
    /** El idioma de la frase de divulgación que se vuelve a añadir (el mismo de recommendSequence). */
    locale?: GuidanceLocale;
  },
  writer: GuidanceWriter,
): Promise<RefineResult> {
  const request: GuidanceRequest = {
    signalKind: proposal.signalKind,
    locale: ctx.locale ?? 'es',
    signalHeadline: ctx.signalHeadline,
    companyName: ctx.companyName,
    briefTitle: ctx.briefTitle,
    briefNotes: ctx.briefNotes,
    requiresDisclosure: ctx.requiresDisclosure,
    steps: proposal.steps.map((s, index) => ({
      index,
      dayOffset: s.dayOffset,
      stepType: s.stepType,
      channel: s.channel,
      angleKey: s.angleKey,
      angleLabel: (s.angleKey && ctx.angles[s.angleKey]?.label) || null,
      forbidden: (s.angleKey && ctx.angles[s.angleKey]?.forbidden) || [],
      draft: s.guidanceEs,
    })),
  };

  let result: GuidanceWriterResult;
  try {
    result = await writer(request);
  } catch {
    return { proposal, source: 'rules', usage: null, keptRules: proposal.steps.length, failed: true };
  }

  const byIndex = new Map<number, string>();
  for (const s of result.steps) {
    if (Number.isInteger(s.index) && typeof s.guidance === 'string' && !byIndex.has(s.index)) byIndex.set(s.index, s.guidance);
  }
  let keptRules = 0;
  const steps = proposal.steps.map((s, i) => {
    const text = byIndex.get(i);
    if (text === undefined || guidanceProblem(text) !== null) {
      keptRules++;
      return s;
    }
    return {
      ...s,
      guidanceEs: withDisclosure(text.trim(), s.angleKey, ctx.requiresDisclosure, ctx.locale),
      guidanceSource: 'llm' as const,
    };
  });
  return {
    proposal: { ...proposal, steps },
    source: keptRules < proposal.steps.length ? 'llm' : 'rules',
    usage: result.usage,
    keptRules,
    failed: false,
  };
}
