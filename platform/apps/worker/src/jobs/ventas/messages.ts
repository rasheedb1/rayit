/**
 * Los textos que el motor de cadencias pone en lo que sale (VEN-10): el
 * pie de baja de cada correo. Un solo lugar, por idioma del workspace
 * (workspace.locale: 'es-CO' → es, 'en-US' → en; lo que no se conoce, es).
 *
 * El pie lleva la dirección postal del workspace (CAN-SPAM, lo exige
 * outbound_policy para encender el envío) y el enlace de baja de un clic
 * (0037 §4.5). VEN-15 puede cambiar la redacción aquí sin tocar el
 * despachador.
 */
export const OUTREACH_MESSAGES = {
  es: {
    footerSeparator: '—',
    unsubscribe: 'Si no quieres recibir más mensajes míos, date de baja aquí:',
  },
  en: {
    footerSeparator: '—',
    unsubscribe: "If you'd rather not hear from me again, unsubscribe here:",
  },
} as const;

export type OutreachLang = keyof typeof OUTREACH_MESSAGES;

export function langOf(locale: string | null | undefined): OutreachLang {
  const l = (locale ?? '').toLowerCase().slice(0, 2);
  return l === 'en' ? 'en' : 'es';
}

/** El cuerpo de un correo con su pie: separador, dirección postal y enlace de baja. */
export function withOptoutFooter(body: string, opts: { locale: string | null; postalAddress: string | null; unsubscribeUrl: string | null }): string {
  const m = OUTREACH_MESSAGES[langOf(opts.locale)];
  const lines = [body.trimEnd(), '', m.footerSeparator];
  if (opts.postalAddress?.trim()) lines.push(opts.postalAddress.trim());
  if (opts.unsubscribeUrl) lines.push(`${m.unsubscribe} ${opts.unsubscribeUrl}`);
  return lines.join('\n');
}
