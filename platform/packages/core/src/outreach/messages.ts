/**
 * Ventas · los textos del motor de cadencias, en un solo
 * lugar por idioma: los avisos de la campana, las etiquetas de cada
 * canal, por qué no salió un mensaje y por qué quedó retenido.
 *
 * Vive en @mc/core porque lo leen tres: @mc/db (que escribe el aviso en
 * la misma transacción del envío o de la respuesta), el worker (el
 * resumen de job:dispatch) y la web (la cola de VEN-16 pintará
 * held_reason con holdReasonText). @mc/db no escribe frases: guarda
 * códigos estables (held_reason, blocked_reason) y, cuando un aviso
 * necesita una frase, la toma de aquí en el idioma del workspace.
 *
 * En la voz del producto: «mensaje», nunca la jerga interna «toque»; y
 * sin nombres de columnas ni de tablas.
 */

export type NoticeLang = 'es' | 'en';

/** 'es-CO' → es, 'en-US' → en; lo que no se conoce, es. */
export function noticeLang(locale: string | null | undefined): NoticeLang {
  return (locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'es';
}

/** Adónde lleva cada aviso. Una sola definición: la usan @mc/db y el worker. */
export const OUTREACH_URLS = {
  /** Donde se conecta y se reconecta una cuenta de envío (VEN-9). */
  channels: '/ventas/canales',
  /** La dirección postal en la política de envío (VEN-15): la pide un correo antes de salir. */
  policyPostalAddress: '/ventas/politica#postalAddress',
  /** El interruptor del envío en la política: apagado, lo programado espera. */
  policySwitch: '/ventas/politica#interruptor',
  /** La ficha de una empresa: sus contactos, su negocio y su actividad. */
  company: (companyId: string) => `/ventas/empresas/${companyId}`,
  /**
   * El bloque «Mensajes de la cadencia» de la ficha: los retenidos con
   * su «Revisar y aprobar», y las respuestas. Adonde llevan los avisos de un
   * mensaje retenido, fallido o respondido.
   */
  companyCadence: (companyId: string) => `/ventas/empresas/${companyId}#cadencia`,
} as const;

/** La nota de una invitación de LinkedIn: 300 caracteres (documentación de Unipile, /users/invite). */
export const LINKEDIN_INVITE_NOTE_MAX = 300;

/** Cuántos caracteres tiene la nota (sin partir un emoji), o null si cabe. */
export function inviteNoteOverflow(body: string | null | undefined): number | null {
  const n = [...(body ?? '').trim()].length;
  return n > LINKEDIN_INVITE_NOTE_MAX ? n : null;
}

// ---------------------------------------------------------------------
// Canales
// ---------------------------------------------------------------------

/** Cómo se llama cada canal para una persona. */
export const CHANNEL_LABELS: Record<NoticeLang, Record<string, string>> = {
  es: { email: 'correo', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
  en: { email: 'email', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
};

export function channelLabel(lang: NoticeLang, channel: string): string {
  return CHANNEL_LABELS[lang][channel] ?? channel;
}

// ---------------------------------------------------------------------
// Por qué no salió (blocked_reason de un toque fallido)
// ---------------------------------------------------------------------

/** Por qué no salió un mensaje, en palabras. Lo que no está aquí se dice de forma genérica. */
export const FAILURE_REASON_TEXTS: Record<NoticeLang, Record<string, string>> = {
  es: {
    account_unavailable: 'la cuenta del canal no está conectada',
    account_auth: 'la cuenta del canal perdió el permiso y hay que reconectarla',
    bounced: 'el correo rebotó',
    invalid_recipient: 'la dirección no es válida',
    rejected: 'el proveedor lo rechazó',
    max_attempts: 'fallaron los cinco intentos',
    zombie: 'el envío quedó a medias y no se reintenta para no duplicarlo',
    not_configured: 'el canal no está configurado en la plataforma',
    token_expired: 'el permiso del buzón venció y la plataforma no tiene las llaves de Google para renovarlo',
    secret_missing: 'no encontramos el permiso guardado de la cuenta',
    note_too_long: `la nota de la invitación de LinkedIn pasa de ${LINKEDIN_INVITE_NOTE_MAX} caracteres`,
    email_invalid: 'el correo de la ficha rebotó antes',
    company_cap: 'la marca ya recibió todos los mensajes que permite tu política',
  },
  en: {
    account_unavailable: 'the channel account is not connected',
    account_auth: 'the channel account lost its permission and needs to be reconnected',
    bounced: 'the email bounced',
    invalid_recipient: 'the address is not valid',
    rejected: 'the provider rejected it',
    max_attempts: 'all five attempts failed',
    zombie: 'the send was interrupted and is not retried to avoid a duplicate',
    not_configured: 'the channel is not configured on the platform',
    token_expired: "the mailbox permission expired and the platform doesn't have the Google keys to renew it",
    secret_missing: "we couldn't find the account's stored permission",
    note_too_long: `the LinkedIn invitation note is longer than ${LINKEDIN_INVITE_NOTE_MAX} characters`,
    email_invalid: "the contact's email bounced before",
    company_cap: 'the brand already received every message your policy allows',
  },
};

export function failureReason(lang: NoticeLang, code: string): string {
  return FAILURE_REASON_TEXTS[lang][code] ?? (lang === 'en' ? 'the provider returned an error' : 'el proveedor devolvió un error');
}

// ---------------------------------------------------------------------
// Por qué quedó retenido (held_reason)
// ---------------------------------------------------------------------
//
// held_reason guarda un CÓDIGO estable, con un dato detrás de «:» cuando
// hace falta, nunca una frase: la cola de VEN-16 la traduce al idioma del
// workspace con holdReasonText. Lo que escriba una persona al retener a
// mano (cualquier otro texto) se muestra tal cual.
//
//   no_postal_address          falta la dirección postal del pie de baja
//   no_body                    el mensaje no tiene texto
//   placeholders:<huecos>      quedan huecos sin rellenar ({{x}}, [x], TBD…)
//   reply_without_thread       respuesta en el hilo a un correo que no salió
//   unconfirmed_attempt:<n>    no se pudo comprobar si el intento n salió
//   note_too_long:<n>          la nota de la invitación de LinkedIn tiene n caracteres
//   no_subject                 un correo nuevo sin asunto (la respuesta en el hilo usa «Re: …»)
//   needs_review               espera la aprobación de una persona: la
//                              revisión humana de la política, o una secuencia
//                              en modo 'review'
//
// Los de la puerta de calidad (VEN-12):
//   quality_warmup:<n>         el mensaje pasó la revisión automática, pero es
//                              de los diez primeros de su tipo (n aprobados hasta hoy)
//   quality_risk:<riesgos>     un disparador de riesgo (cifra sin origen,
//                              urgencia falsa…) obliga a que lo mire una persona
//   quality_low:<nota>         la revisión automática no le dio el mínimo
//   quality_preflight:<códigos> ninguna versión pasó el pre-vuelo
//   quality_duplicate          el mismo texto ya le llegó a esta persona
//   llm_budget                 se acabó el presupuesto diario de redacción
//   llm_error                  el modelo no devolvió un mensaje legible

export const HOLD_CODES = [
  'no_postal_address', 'no_body', 'placeholders', 'reply_without_thread', 'unconfirmed_attempt', 'note_too_long', 'needs_review',
  'no_subject', 'quality_warmup', 'quality_risk', 'quality_low', 'quality_preflight', 'quality_duplicate', 'llm_budget', 'llm_error',
  'cooldown_over',
] as const;

/** Los disparadores de riesgo en palabras (outbound_review.risk_triggers). */
export const RISK_TRIGGER_TEXTS: Record<NoticeLang, Record<string, string>> = {
  es: {
    unsourced_figure: 'una cifra sin origen en tu perfil',
    invented_client: 'una marca nombrada como cliente sin campaña que lo respalde',
    false_urgency: 'urgencia que no existe',
    pressure: 'un tono de presión',
    competitor_mention: 'la mención de un competidor de la marca',
    missing_disclosure: 'falta decir que la colaboración es pagada',
  },
  en: {
    unsourced_figure: 'a figure with no source in your profile',
    invented_client: 'a brand named as a client with no campaign behind it',
    false_urgency: 'urgency that is not real',
    pressure: 'a pushy tone',
    competitor_mention: "a mention of the brand's competitor",
    missing_disclosure: 'it does not say the collaboration is paid',
  },
};

/**
 * Las dimensiones de la rúbrica del juez (relevance, quality, structure,
 * voice) en palabras: la nota que ve la persona nunca lleva los
 * identificadores internos.
 */
export const RUBRIC_DIMENSION_LABELS: Record<NoticeLang, Record<'relevance' | 'quality' | 'structure' | 'voice', string>> = {
  es: { relevance: 'relevancia', quality: 'calidad', structure: 'estructura', voice: 'voz' },
  en: { relevance: 'relevance', quality: 'quality', structure: 'structure', voice: 'voice' },
};

/** Una nota de 0 a 10 con un decimal, con la coma o el punto del idioma. */
const score = (lang: NoticeLang, d: string) =>
  Number.isFinite(Number(d)) && d !== '' ? new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(Number(d)) : null;

const riskList = (lang: NoticeLang, d: string) =>
  d.split(',').filter(Boolean).map((r) => RISK_TRIGGER_TEXTS[lang][r] ?? r).join(', ');
export type HoldCode = (typeof HOLD_CODES)[number];

export interface HoldReason {
  code: HoldCode;
  /** Los huecos, el número del intento o el largo de la nota. */
  detail?: string | number;
}

/** El valor de held_reason: el código, y su dato detrás de «:». */
export function formatHoldReason(r: HoldReason): string {
  return r.detail === undefined || r.detail === '' ? r.code : `${r.code}:${r.detail}`;
}

/** Lee un held_reason. null si no es un código del motor (lo escribió una persona). */
export function parseHoldReason(value: string | null | undefined): HoldReason | null {
  if (!value) return null;
  const i = value.indexOf(':');
  const code = i < 0 ? value : value.slice(0, i);
  if (!(HOLD_CODES as readonly string[]).includes(code)) return null;
  return i < 0 ? { code: code as HoldCode } : { code: code as HoldCode, detail: value.slice(i + 1) };
}

export const HOLD_REASON_TEXTS: Record<NoticeLang, Record<HoldCode, (detail: string) => string>> = {
  es: {
    no_postal_address: () => 'falta la dirección postal que va en el pie de los correos; agrégala en la política de envío',
    no_body: () => 'el mensaje no tiene texto',
    placeholders: (d) => `quedan huecos sin rellenar (${d})`,
    reply_without_thread: () =>
      'es una respuesta en el hilo, pero todavía no tenemos el hilo del correo al que responde (no salió, o lo confirmaste a mano y lo estamos buscando)',
    unconfirmed_attempt: () =>
      'no sabemos si salió porque el proveedor no lo confirmó; búscalo en tu carpeta de enviados (o en el chat) y dinos si salió, para no mandarlo dos veces',
    note_too_long: (d) => `la nota de la invitación de LinkedIn tiene ${d} caracteres y el máximo es ${LINKEDIN_INVITE_NOTE_MAX}`,
    needs_review: () => 'espera tu aprobación antes de salir (la revisión humana está encendida)',
    no_subject: () => 'es un correo nuevo y no tiene asunto; escríbelo antes de aprobarlo',
    quality_warmup: (d) =>
      `pasó la revisión automática, pero los diez primeros mensajes de cada tipo los aprueba una persona (llevas ${d || '0'})`,
    quality_risk: (d) => `la revisión automática encontró ${riskList('es', d)}; revísalo antes de aprobarlo`,
    quality_low: (d) =>
      `la revisión automática le dio ${score('es', d) ?? 'una nota'} de 10, por debajo del mínimo; edítalo (si es un correo, también puedes pedir otra versión en «Redactar pitch»)`,
    quality_preflight: () => 'ninguna versión pasó las reglas de estilo y de cifras; edítalo antes de aprobarlo',
    quality_duplicate: () => 'es igual a un mensaje que esta persona ya recibió',
    llm_budget: () => 'se acabó el presupuesto de redacción con IA de hoy; revísalo o escríbelo tú',
    llm_error: () => 'la redacción con IA no devolvió un mensaje legible; escríbelo tú',
    cooldown_over: () => 'la marca dijo «ahora no» hace noventa días; la cadencia vuelve solo si tú lo apruebas',
  },
  en: {
    no_postal_address: () => 'the postal address for the email footer is missing; add it in the sending policy',
    no_body: () => 'the message has no text',
    placeholders: (d) => `there are unfilled placeholders (${d})`,
    reply_without_thread: () =>
      "it's a reply in the thread, but we don't have the thread of the email it replies to yet (it wasn't sent, or you confirmed it by hand and we're looking for it)",
    unconfirmed_attempt: () =>
      "we don't know whether it went out because the provider didn't confirm it; look for it in your sent folder (or the chat) and tell us whether it did, so it isn't sent twice",
    note_too_long: (d) => `the LinkedIn invitation note has ${d} characters and the limit is ${LINKEDIN_INVITE_NOTE_MAX}`,
    needs_review: () => 'it waits for your approval before going out (human review is on)',
    no_subject: () => "it's a new email with no subject; write one before approving it",
    quality_warmup: (d) => `it passed the automatic review, but a person approves the first ten messages of each type (${d || '0'} so far)`,
    quality_risk: (d) => `the automatic review found ${riskList('en', d)}; check it before approving it`,
    quality_low: (d) =>
      `the automatic review scored it ${score('en', d) ?? 'low'} out of 10, under the minimum; edit it (for an email, you can also ask for another version in «Write pitch»)`,
    quality_preflight: () => 'no version passed the style and figure rules; edit it before approving it',
    quality_duplicate: () => 'it is the same as a message this person already got',
    llm_budget: () => "today's AI writing budget ran out; review it or write it yourself",
    llm_error: () => 'AI writing did not return a readable message; write it yourself',
    cooldown_over: () => 'the brand said "not now" ninety days ago; the cadence only comes back if you approve it',
  },
};

/**
 * held_reason en palabras, en el idioma del workspace, sin puntuación al
 * final: quien lo pinta pone la suya («Retenido: ….», «quedó retenido:
 * …. Lo que sigue…»). Lo que no es un código (un motivo que escribió una
 * persona) se devuelve tal cual, sin su punto final, para no pintarlo con
 * dos.
 */
/**
 * La nota baja dicha desde la bandeja de aprobación (VEN-14): allí la
 * acción está en la propia fila. Con «Regenerar», se la nombra; sin él (una
 * respuesta en el hilo, un mensaje de LinkedIn), solo se edita. La frase de
 * HOLD_REASON_TEXTS remite a «Redactar pitch», que es la de la ficha.
 */
const QUALITY_LOW_IN_QUEUE: Record<NoticeLang, Record<'regenerable' | 'edit_only', (d: string) => string>> = {
  es: {
    regenerable: (d) =>
      `la revisión automática le dio ${score('es', d) ?? 'una nota'} de 10, por debajo del mínimo; edítalo o pide otra versión con «Regenerar»`,
    edit_only: (d) =>
      `la revisión automática le dio ${score('es', d) ?? 'una nota'} de 10, por debajo del mínimo; revísalo: puedes editarlo o aprobarlo tal cual`,
  },
  en: {
    regenerable: (d) =>
      `the automatic review scored it ${score('en', d) ?? 'low'} out of 10, under the minimum; edit it or ask for another version with «Regenerate»`,
    edit_only: (d) =>
      `the automatic review scored it ${score('en', d) ?? 'low'} out of 10, under the minimum; review it: you can edit it or approve it as is`,
  },
};

/**
 * held_reason en palabras. `where` dice desde dónde se lee: la ficha
 * (por defecto, remite a «Redactar pitch») o una fila de la bandeja de
 * aprobación, con o sin «Regenerar».
 */
export function holdReasonText(
  lang: NoticeLang, value: string, where: 'record' | 'queue_regenerable' | 'queue_edit_only' = 'record',
): string {
  const r = parseHoldReason(value);
  if (!r) return value.trim().replace(/[.!?…]+$/u, '');
  const detail = r.detail === undefined ? '' : String(r.detail);
  if (r.code === 'quality_low' && where !== 'record') {
    return QUALITY_LOW_IN_QUEUE[lang][where === 'queue_regenerable' ? 'regenerable' : 'edit_only'](detail);
  }
  return HOLD_REASON_TEXTS[lang][r.code](detail);
}

// ---------------------------------------------------------------------
// Los avisos de la campana
// ---------------------------------------------------------------------

/**
 * Lo que detuvo una respuesta además de su cadencia (0054): los otros
 * enrolamientos de la misma persona y las personas de la misma marca
 * cuya cadencia quedó en pausa.
 */
export interface ReplyStop {
  otherSequences: number;
  pausedPeople: number;
  company: string;
}

const NO_STOP: ReplyStop = { otherSequences: 0, pausedPeople: 0, company: '' };

/**
 * El cuerpo que se guarda de una respuesta que solo trae un adjunto (una
 * foto, una nota de voz, un sticker de LinkedIn o Instagram). Es una
 * respuesta y detiene la cadencia; el webhook y el lector del motor
 * guardan el mismo texto, para que la base quede igual venga por donde
 * venga.
 */
export const INBOUND_ATTACHMENT_BODY = '[adjunto]';

/** El cuerpo de un mensaje entrante: su texto, o el marcador si solo trae adjuntos. */
export function inboundBody(text: string, hasAttachments: boolean): string {
  return text.trim() === '' && hasAttachments ? INBOUND_ATTACHMENT_BODY : text;
}

/** Los textos de cada aviso del motor, por idioma. */
export const OUTREACH_NOTICE_TEXTS = {
  es: {
    failedTitle: (company: string) => `Un mensaje a ${company} no salió`,
    failedBody: (who: string, channel: string, reason: string, company: string) =>
      `El mensaje a ${who} por ${channel} no se envió: ${reason}. Revisa la ficha de ${company}.`,
    heldTitle: (company: string) => `Un mensaje a ${company} espera tu revisión`,
    heldBody: (who: string, channel: string, reason: string) =>
      `El mensaje a ${who} por ${channel} quedó retenido: ${reason}. Lo que sigue de esa cadencia espera; apruébalo, edítalo o sáltalo en Aprobaciones.`,
    replyTitle: (who: string) => `${who} respondió`,
    replyBody: (channel: string, stop: ReplyStop = NO_STOP) =>
      `Llegó una respuesta por ${channel}. Lo pendiente con esa persona se canceló` +
      (stop.otherSequences > 0 ? `, también en ${stop.otherSequences === 1 ? 'otra secuencia' : `otras ${stop.otherSequences} secuencias`}` : '') +
      '.' +
      (stop.pausedPeople > 0
        ? ` Pausamos también ${stop.pausedPeople === 1 ? 'la cadencia de otra persona' : `las cadencias de otras ${stop.pausedPeople} personas`} de ${stop.company}, ` +
          'para que no les lleguen mensajes mientras sigue la conversación.'
        : ''),
    optOutTitle: (who: string) => `${who} pidió no recibir más mensajes`,
    optOutBody: () => 'Se marcó la baja: no le volverás a escribir desde On Cue. Lo pendiente con esa persona se canceló.',
    /** Pidió la baja alguien del hilo que no es la ficha: lo decide una persona. */
    optOutReviewTitle: (who: string) => `Alguien en el hilo con ${who} pidió no recibir más mensajes`,
    optOutReviewBody: (from: string, who: string) =>
      `Lo escribió ${from}, que no es el correo de ${who}. La cadencia se detuvo y ${who} no quedó de baja: revisa la conversación y márcala a mano si corresponde.`,
    /** contact.opted_out_reason cuando una respuesta pide la baja. */
    optOutReason: (channel: string) => `Pidió no ser contactado, respondiendo por ${channel}.`,
    accountDownTitle: (channel: string) => `Tu cuenta de ${channel} no está conectada`,
    accountDownBody: (count: number, channel: string) =>
      `${count === 1 ? 'Un mensaje espera' : `${count} mensajes esperan`} a que reconectes tu cuenta de ${channel}. ` +
      'Salen solos en cuanto vuelva a estar conectada.',
  },
  en: {
    failedTitle: (company: string) => `A message to ${company} was not sent`,
    failedBody: (who: string, channel: string, reason: string, company: string) =>
      `The message to ${who} over ${channel} was not sent: ${reason}. Check ${company}'s page.`,
    heldTitle: (company: string) => `A message to ${company} needs your review`,
    heldBody: (who: string, channel: string, reason: string) =>
      `The message to ${who} over ${channel} is on hold: ${reason}. The rest of that cadence waits; approve, edit or skip it in Approvals.`,
    replyTitle: (who: string) => `${who} replied`,
    replyBody: (channel: string, stop: ReplyStop = NO_STOP) =>
      `A reply came in over ${channel}. Everything pending for that person was canceled` +
      (stop.otherSequences > 0 ? `, also in ${stop.otherSequences === 1 ? 'another sequence' : `${stop.otherSequences} other sequences`}` : '') +
      '.' +
      (stop.pausedPeople > 0
        ? ` We also paused the cadence${stop.pausedPeople === 1 ? ' of one other person' : `s of ${stop.pausedPeople} other people`} at ${stop.company}, ` +
          'so no messages reach them while the conversation goes on.'
        : ''),
    optOutTitle: (who: string) => `${who} asked not to be contacted again`,
    optOutBody: () => "The opt-out was recorded: you won't write to them again from On Cue. Anything pending for them was canceled.",
    optOutReviewTitle: (who: string) => `Someone in the thread with ${who} asked not to be contacted`,
    optOutReviewBody: (from: string, who: string) =>
      `It came from ${from}, which is not ${who}'s email. The cadence stopped and ${who} was not opted out: check the conversation and mark it by hand if it applies.`,
    optOutReason: (channel: string) => `Asked not to be contacted, replying over ${channel}.`,
    accountDownTitle: (channel: string) => `Your ${channel} account is not connected`,
    accountDownBody: (count: number, channel: string) =>
      `${count === 1 ? 'One message is' : `${count} messages are`} waiting for you to reconnect your ${channel} account. ` +
      'They go out on their own once it is connected again.',
  },
} as const;
