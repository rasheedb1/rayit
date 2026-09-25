/**
 * El pie obligatorio de cada correo del outreach (VEN-15): la frase de
 * baja con su enlace y la dirección postal del workspace. Funciones puras.
 * Los textos viven en ./messages.ts.
 *
 * CAN-SPAM pide una dirección postal válida y una forma clara de darse de
 * baja en cada correo comercial; el RGPD y las leyes locales de protección
 * de datos, lo mismo en espíritu. La base ya no deja encender el envío sin
 * dirección (outbound_policy_enabled_needs_address); esto es la misma
 * regla para cada correo: sin dirección o sin enlace, el correo no está
 * listo y el despachador no lo reclama.
 */
import { FOOTER_TEXTS, OUTREACH_FALLBACK_LANGUAGE, type FooterTexts } from './messages.ts';

export type ComplianceGap = 'postal_address' | 'unsubscribe_link';

export interface ComplianceInput {
  /** outbound_policy.postal_address del workspace. */
  postalAddress: string | null | undefined;
  /** La URL de baja de ESTE correo (optoutUrl). */
  unsubscribeUrl: string | null | undefined;
}

export type ComplianceReadiness = { ready: true } | { ready: false; missing: ComplianceGap[] };

/** Una dirección postal que sirve: algo más que espacios. La misma regla que el CHECK de la base. */
export function hasPostalAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Si el correo puede marcarse listo para salir, y qué le falta si no. */
export function complianceReadiness(input: ComplianceInput): ComplianceReadiness {
  const missing: ComplianceGap[] = [];
  if (!hasPostalAddress(input.postalAddress)) missing.push('postal_address');
  if (!input.unsubscribeUrl || !/^https?:\/\//.test(input.unsubscribeUrl)) missing.push('unsubscribe_link');
  return missing.length ? { ready: false, missing } : { ready: true };
}

export interface EmailFooter {
  text: string;
  html: string;
}

export type EmailFooterResult = { ok: true; footer: EmailFooter } | { ok: false; missing: ComplianceGap[] };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * El pie de cada correo: la frase de baja con su enlace y la dirección
 * postal del workspace, en texto y en HTML. Sin dirección o sin enlace no
 * hay pie, y el correo no está listo (complianceReadiness). Los textos,
 * con footerTextsFor(workspace.locale); sin ellos, los del idioma de
 * respaldo.
 */
export function buildEmailFooter(input: ComplianceInput & { texts?: FooterTexts }): EmailFooterResult {
  const listo = complianceReadiness(input);
  if (!listo.ready) return { ok: false, missing: listo.missing };
  const texts = input.texts ?? FOOTER_TEXTS[OUTREACH_FALLBACK_LANGUAGE];
  const url = input.unsubscribeUrl as string;
  const direccion = (input.postalAddress as string).trim().replace(/\s*\n\s*/g, ', ');
  const text = `--\n${texts.unsubscribeText.replace('{url}', url)}\n${direccion}`;
  const html =
    '<p style="margin-top:24px;font-size:12px;color:#6b7280;line-height:1.5">' +
    `${escapeHtml(texts.unsubscribeHtmlLead)} <a href="${escapeHtml(url)}">${escapeHtml(texts.unsubscribeLinkLabel)}</a>.` +
    `<br>${escapeHtml(direccion)}</p>`;
  return { ok: true, footer: { text, html } };
}
