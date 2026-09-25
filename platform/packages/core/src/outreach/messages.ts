/**
 * Los textos del outreach que viajan DENTRO del correo que recibe la marca
 * (VEN-15 r5): hoy, el pie de baja. Un solo sitio para todos los idiomas,
 * como el messages.ts de cada pantalla. La pantalla de baja y los avisos
 * del worker tienen su propio messages.ts; lo que comparten con este es
 * la regla del idioma (outreachLanguage).
 *
 * Para sumar un idioma: agregarlo a OUTREACH_LANGUAGES y a FOOTER_TEXTS.
 * TypeScript no deja olvidar ninguno de los dos.
 */

/** Los idiomas en que sale hoy el outreach. */
export const OUTREACH_LANGUAGES = ['es', 'en'] as const;
export type OutreachLanguage = (typeof OUTREACH_LANGUAGES)[number];

/**
 * El respaldo explícito: el idioma por defecto de un workspace nuevo
 * (workspace.locale = 'es-CO'). Un locale que el outreach todavía no
 * habla ('pt-BR', 'fr') sale en este.
 */
export const OUTREACH_FALLBACK_LANGUAGE: OutreachLanguage = 'es';

function esIdioma(valor: string): valor is OutreachLanguage {
  return (OUTREACH_LANGUAGES as readonly string[]).includes(valor);
}

/**
 * El idioma del outreach para un locale BCP 47 ('es-CO', 'en-US',
 * 'EN_gb'…), por su idioma base con Intl.Locale. Lo que Intl no entiende
 * (vacío, basura) va al respaldo.
 */
export function outreachLanguage(locale: string | null | undefined): OutreachLanguage {
  if (!locale) return OUTREACH_FALLBACK_LANGUAGE;
  try {
    const base = new Intl.Locale(locale.replace(/_/g, '-')).language.toLowerCase();
    return esIdioma(base) ? base : OUTREACH_FALLBACK_LANGUAGE;
  } catch {
    return OUTREACH_FALLBACK_LANGUAGE;
  }
}

/**
 * Los textos del pie. Van en el correo que recibe la marca, en el idioma
 * del workspace; `{url}` es el enlace de baja.
 */
export interface FooterTexts {
  /** Frase de baja en texto plano, con `{url}`. */
  unsubscribeText: string;
  /** La frase de baja en HTML, sin el enlace: lo pone buildEmailFooter. */
  unsubscribeHtmlLead: string;
  /** El texto del enlace en HTML. */
  unsubscribeLinkLabel: string;
}

export const FOOTER_TEXTS: Readonly<Record<OutreachLanguage, FooterTexts>> = {
  es: {
    unsubscribeText: 'Si no quieres recibir más mensajes míos, date de baja aquí: {url}',
    unsubscribeHtmlLead: 'Si no quieres recibir más mensajes míos,',
    unsubscribeLinkLabel: 'date de baja aquí',
  },
  en: {
    unsubscribeText: "If you'd rather not hear from me again, unsubscribe here: {url}",
    unsubscribeHtmlLead: "If you'd rather not hear from me again,",
    unsubscribeLinkLabel: 'unsubscribe here',
  },
};

/** Los textos del pie para el locale del workspace (outreachLanguage). */
export function footerTextsFor(locale: string | null | undefined): FooterTexts {
  return FOOTER_TEXTS[outreachLanguage(locale)];
}
