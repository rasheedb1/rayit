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
 *      ese canal. Un correo que queda como primero del hilo es `email`,
 *      nunca `email_reply`.
 *   3. La guía: la de la plantilla si el paso quedó como estaba; si
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

/** Los tipos de señal de outbound_sequence_template.signal_kind que el recomendador distingue. */
export const RECOMMEND_SIGNAL_KINDS = ['active_campaign', 'launch', 'season', 'collab', 'manual'] as const;
export type RecommendSignalKind = (typeof RECOMMEND_SIGNAL_KINDS)[number];

/** Los canales en los que el recomendador puede poner un paso. WhatsApp es fase 2 (§5.1). */
export const RECOMMEND_CHANNELS = ['email', 'linkedin', 'instagram_dm'] as const;
export type RecommendChannel = (typeof RECOMMEND_CHANNELS)[number];

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
  /** Lo que decía la plantilla, si el recomendador lo cambió. */
  changedFrom: { stepType: string; channel: string } | null;
}

/** Por qué un paso no se quedó en su canal. */
export type RerouteReason = 'channel_not_allowed' | 'channel_not_connected' | 'contact_has_no_address';

/** Lo que el recomendador decidió, en códigos (la pantalla los traduce). */
export type ProposalNote =
  | { code: 'template'; slug: string; match: 'niche_and_signal' | 'signal' | 'generic' }
  | { code: 'rerouted'; step: number; from: string; to: string; manual: boolean; reason: RerouteReason }
  | { code: 'unreachable'; step: number; channel: string }
  | { code: 'channel_down'; channel: RecommendChannel }
  | { code: 'no_contact' }
  | { code: 'disclosure' };

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
function blockerFor(input: RecommendInput, channel: string, needsAddress: boolean): RerouteReason | null {
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

/** Cómo se nombra la señal dentro de una guía. */
const SIGNAL_PHRASE: Record<RecommendSignalKind, string> = {
  active_campaign: 'su campaña activa',
  launch: 'su lanzamiento',
  season: 'la temporada que viene',
  collab: 'su categoría',
  manual: 'su marca',
};

/** Con qué abre cada ángulo (sin el canal). */
const ANGLE_OPENING: Record<string, (signal: string) => string> = {
  presencia: () => 'algo concreto de su último post, en una o dos frases',
  encaje_audiencia: () => 'la coincidencia entre tu audiencia y su cliente, con una cifra de tu perfil',
  prueba_desempeno: (s) => `un video tuyo parecido a lo que necesita ${s}, con sus views frente a tu mediana`,
  concepto_creativo: (s) => `una idea de video concreta para ${s}`,
  prueba_social: () => 'el resultado medido de una campaña tuya con una marca del mismo sector',
  sintesis: () => 'un resumen de tres líneas, el enlace al media kit y a la cotización y una fecha concreta para hablar',
};

/** Qué no se menciona en cada ángulo (lo más importante de outbound_angle.forbidden_es). */
const ANGLE_FORBIDDEN: Record<string, string> = {
  presencia: 'No vendas, no menciones tarifas ni pongas enlaces.',
  encaje_audiencia: 'No menciones precio ni adjuntes el media kit.',
  prueba_desempeno: 'No repitas la demografía ya dicha ni uses cifras sin origen.',
  concepto_creativo: 'Sin cifras de audiencia ni ideas que sirvan para cualquier marca.',
  prueba_social: 'Solo campañas con resultado; no nombres a su competencia directa.',
  sintesis: 'Sin presión ni urgencia falsa.',
};

const COLLAB_FORBIDDEN = 'No nombres la colaboración que viste ni a quien la hizo.';
/** La frase de divulgación que el brief pide en el cierre (outbound_brief.requires_disclosure). */
export const DISCLOSURE_GUIDANCE = 'Di que el contenido irá marcado como publicidad.';

/**
 * La guía de un paso compuesta con reglas: canal + ángulo + señal. Es la
 * que queda cuando el paso cambió de canal o cuando el modelo no da una
 * que sirva.
 */
export function composeGuidance(angleKey: string | null, stepType: string, signalKind: RecommendSignalKind): string {
  const signal = SIGNAL_PHRASE[signalKind];
  const opening = (angleKey && ANGLE_OPENING[angleKey]?.(signal)) || `algo específico de ${signal}`;
  const forbidden = (angleKey && ANGLE_FORBIDDEN[angleKey]) || 'No vendas en el primer párrafo.';
  const collab = signalKind === 'collab' ? ` ${COLLAB_FORBIDDEN}` : '';
  const family = familyOf(stepType);
  let lead: string;
  let close = ' Cierra con una sola pregunta.';
  if (family === 'public_comment') {
    lead = `Comenta ${opening}.`;
    close = '';
  } else if (family === 'public_like' || family === 'manual') {
    lead = `Hazlo a mano: reacciona o comenta ${opening}.`;
    close = '';
  } else if (stepType === 'email_reply') {
    lead = `Responde en el mismo hilo con ${opening}.`;
  } else if (stepType === 'linkedin_connect') {
    lead = `Nota de conexión de menos de 300 caracteres con ${opening}.`;
    close = '';
  } else if (family === 'direct') {
    lead = `Mensaje corto con ${opening}.`;
  } else {
    lead = `Abre con ${opening}.`;
  }
  if (angleKey === 'sintesis') close = '';
  return `${lead} ${forbidden}${collab}${close}`;
}

function withDisclosure(guidance: string, angleKey: string | null, requires: boolean): string {
  if (!requires || angleKey !== 'sintesis' || guidance.includes(DISCLOSURE_GUIDANCE)) return guidance;
  return `${guidance} ${DISCLOSURE_GUIDANCE}`;
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

  const notes: ProposalNote[] = [{ code: 'template', slug: template.slug, match }];
  if (!input.contact) notes.push({ code: 'no_contact' });

  const ordered = [...template.steps].sort((a, b) => a.day_offset - b.day_offset || a.order_in_day - b.order_in_day);
  const steps: ProposedStep[] = [];
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
    // El primer correo abre el hilo: un email_reply sin correo antes no tiene a qué responder.
    if (channel === 'email' && stepType === 'email_reply' && !emailSeen) stepType = 'email';
    if (channel === 'email') emailSeen = true;

    const changed = stepType !== s.step_type || channel !== s.channel;
    const base = changed ? composeGuidance(s.angle_key, stepType, input.signalKind) : s.guidance_es;
    steps.push({
      dayOffset: s.day_offset,
      orderInDay: s.order_in_day,
      stepType,
      channel,
      angleKey: s.angle_key,
      scheduledTime: s.scheduled_time,
      generateWithAi: s.generate_with_ai,
      requiresAsset: s.requires_asset,
      guidanceEs: withDisclosure(base, s.angle_key, input.requiresDisclosure),
      changedFrom: changed ? { stepType: s.step_type, channel: s.channel } : null,
    });
  });

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
// 5 · La guía redactada por el modelo
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
  ctx: Omit<GuidanceRequest, 'steps' | 'signalKind' | 'requiresDisclosure'> & {
    requiresDisclosure: boolean;
    angles: Readonly<Record<string, { label: string; forbidden: readonly string[] }>>;
  },
  writer: GuidanceWriter,
): Promise<RefineResult> {
  const request: GuidanceRequest = {
    signalKind: proposal.signalKind,
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
    return { ...s, guidanceEs: withDisclosure(text.trim(), s.angleKey, ctx.requiresDisclosure) };
  });
  return {
    proposal: { ...proposal, steps },
    source: keptRules < proposal.steps.length ? 'llm' : 'rules',
    usage: result.usage,
    keptRules,
    failed: false,
  };
}
