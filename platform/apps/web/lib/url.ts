/**
 * Un enlace externo que se puede pintar como href, o null.
 *
 * Las columnas de URL de la base (signal.evidence_url, contact.linkedin_url,
 * contact.source_url…) son text libre: hoy las escriben formularios que
 * exigen http(s), pero mañana las llenan los conectores del radar, el
 * outreach y los seeds. Un `javascript:` o un `data:` en un href es un XSS
 * de un clic, y React solo avisa en consola. Por eso toda URL que venga de
 * la base pasa por aquí antes de ser un href: solo http: y https:, y
 * cualquier otra cosa (o una que no se puede leer) no se enlaza.
 *
 * Añadido por Ventas (VEN-5, «Ver la evidencia» de la ficha).
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
