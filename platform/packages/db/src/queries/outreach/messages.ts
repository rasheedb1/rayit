/**
 * Outreach · los textos del motor que ve una persona (VEN-10 r2), en un
 * solo lugar y por idioma del workspace (workspace.locale), como el
 * messages.ts de cada módulo de la web.
 *
 * Son los de la campana (notification): títulos y cuerpos de cada aviso,
 * cómo se llama cada canal y por qué no salió un mensaje, en la voz del
 * producto («mensaje», nunca la jerga interna «toque»). notification
 * guarda el texto ya compuesto en title_es/body_es (el nombre de la
 * columna es de 0002); los compone notices.ts.
 */

export type NoticeLang = 'es' | 'en';

/** 'es-CO' → es, 'en-US' → en; lo que no se conoce, es. */
export function noticeLang(locale: string | null | undefined): NoticeLang {
  return (locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'es';
}

/** Cómo se llama cada canal para una persona. */
export const CHANNEL_LABELS: Record<NoticeLang, Record<string, string>> = {
  es: { email: 'correo', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
  en: { email: 'email', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
};

export function channelLabel(lang: NoticeLang, channel: string): string {
  return CHANNEL_LABELS[lang][channel] ?? channel;
}

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
  },
};

export function failureReason(lang: NoticeLang, code: string): string {
  return FAILURE_REASON_TEXTS[lang][code] ?? (lang === 'en' ? 'the provider returned an error' : 'el proveedor devolvió un error');
}

/** Los textos de cada aviso, por idioma. */
export const OUTREACH_NOTICE_TEXTS = {
  es: {
    failedTitle: (company: string) => `Un mensaje a ${company} no salió`,
    failedBody: (who: string, channel: string, reason: string) =>
      `El mensaje a ${who} por ${channel} no se envió: ${reason}. Revisa la cola de Ventas.`,
    replyTitle: (who: string) => `${who} respondió`,
    replyBody: (channel: string) => `Llegó una respuesta por ${channel}. Lo pendiente de esa cadencia se canceló.`,
    optOutTitle: (who: string) => `${who} pidió no recibir más mensajes`,
    optOutBody: () => 'Se marcó la baja: nadie de tu espacio le volverá a escribir, y lo pendiente para esa persona se canceló.',
    accountDownTitle: (channel: string) => `Tu cuenta de ${channel} no está conectada`,
    accountDownBody: (count: number, channel: string) =>
      `${count === 1 ? 'Un mensaje espera' : `${count} mensajes esperan`} a que reconectes tu cuenta de ${channel}. ` +
      'Salen solos en cuanto vuelva a estar conectada.',
  },
  en: {
    failedTitle: (company: string) => `A message to ${company} was not sent`,
    failedBody: (who: string, channel: string, reason: string) =>
      `The message to ${who} over ${channel} was not sent: ${reason}. Check the Sales queue.`,
    replyTitle: (who: string) => `${who} replied`,
    replyBody: (channel: string) => `A reply came in over ${channel}. What was pending in that cadence was canceled.`,
    optOutTitle: (who: string) => `${who} asked not to be contacted again`,
    optOutBody: () => 'The opt-out was recorded: no one in your workspace will write to them again, and anything pending for them was canceled.',
    accountDownTitle: (channel: string) => `Your ${channel} account is not connected`,
    accountDownBody: (count: number, channel: string) =>
      `${count === 1 ? 'One message is' : `${count} messages are`} waiting for you to reconnect your ${channel} account. ` +
      'They go out on their own once it is connected again.',
  },
} as const;
