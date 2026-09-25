/**
 * Ventas · los textos del motor de cadencias (VEN-10 r4), en un solo
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
  /** La ficha de una empresa: sus contactos, su negocio y su actividad. */
  company: (companyId: string) => `/ventas/empresas/${companyId}`,
  /**
   * (r5) El bloque «Mensajes de la cadencia» de la ficha: los retenidos con
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
//   no_subject                 (r3) un correo nuevo sin asunto (la respuesta en el hilo usa «Re: …»)
//   needs_review               (r5) espera la aprobación de una persona: la
//                              revisión humana de la política, o una secuencia
//                              en modo 'review'

export const HOLD_CODES = [
  'no_postal_address', 'no_body', 'placeholders', 'reply_without_thread', 'unconfirmed_attempt', 'note_too_long', 'needs_review',
  'no_subject',
] as const;
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
    reply_without_thread: () => 'es una respuesta en el hilo, pero el correo al que responde no salió',
    unconfirmed_attempt: (d) =>
      `no pudimos comprobar si el intento ${d} salió; mira tu carpeta de enviados y dinos si salió o no, para no mandarlo dos veces`,
    note_too_long: (d) => `la nota de la invitación de LinkedIn tiene ${d} caracteres y el máximo es ${LINKEDIN_INVITE_NOTE_MAX}`,
    needs_review: () => 'espera tu aprobación antes de salir (la revisión humana está encendida)',
    no_subject: () => 'es un correo nuevo y no tiene asunto; escríbelo antes de aprobarlo',
  },
  en: {
    no_postal_address: () => 'the postal address for the email footer is missing; add it in the sending policy',
    no_body: () => 'the message has no text',
    placeholders: (d) => `there are unfilled placeholders (${d})`,
    reply_without_thread: () => "it's a reply in the thread, but the email it replies to was not sent",
    unconfirmed_attempt: (d) =>
      `we couldn't confirm whether attempt ${d} went out; check your sent folder and tell us whether it did, so it isn't sent twice`,
    note_too_long: (d) => `the LinkedIn invitation note has ${d} characters and the limit is ${LINKEDIN_INVITE_NOTE_MAX}`,
    needs_review: () => 'it waits for your approval before going out (human review is on)',
    no_subject: () => "it's a new email with no subject; write one before approving it",
  },
};

/** held_reason en palabras, en el idioma del workspace. Lo que no es un código se devuelve tal cual. */
export function holdReasonText(lang: NoticeLang, value: string): string {
  const r = parseHoldReason(value);
  if (!r) return value;
  return HOLD_REASON_TEXTS[lang][r.code](r.detail === undefined ? '' : String(r.detail));
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
    heldBody: (who: string, channel: string, reason: string, company: string) =>
      `El mensaje a ${who} por ${channel} quedó retenido: ${reason}. Lo que sigue de esa cadencia espera; revisa la ficha de ${company}.`,
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
    /** (r5) Pidió la baja alguien del hilo que no es la ficha: lo decide una persona. */
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
    heldBody: (who: string, channel: string, reason: string, company: string) =>
      `The message to ${who} over ${channel} is on hold: ${reason}. The rest of that cadence waits; check ${company}'s page.`,
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
