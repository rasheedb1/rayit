/**
 * La clave de una categoría del brief de outbound (VEN-7), en un sitio
 * puro: la usan la consulta (@mc/db/queries/brief, para no guardar
 * «Alcohol» y «alcohol» dos veces) y el componente de cliente de la
 * pantalla (para no dejar agregar la misma dos veces). Un componente de
 * cliente no puede importar @mc/db, que arrastra el cliente de Postgres;
 * antes cada capa tenía su copia y podían separarse.
 *
 * Es la misma idea que brand_key en SQL (0031): sin tildes, sin
 * mayúsculas, sin signos. La comparación con las señales la hace la base
 * con brand_key; esta solo decide qué cuenta como repetida al escribir.
 */
export function categoryKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Cómo se le nombra al modelo cada formato de entregable del brief
 * (DELIVERABLES de campanas.ts), para que el pitch y la guía de las
 * cadencias propongan solo lo que el creador ofrece (VEN-7 r4). Es texto
 * para el prompt, no para la pantalla: la pantalla tiene los suyos en
 * su messages.ts. Un formato que no está aquí va con su nombre tal cual.
 */
const DELIVERABLE_PROMPT_NAMES: Readonly<Record<string, string>> = {
  reel: 'reel de Instagram',
  tiktok: 'video de TikTok',
  historia: 'historias de Instagram',
  historias: 'historias de Instagram',
  short: 'YouTube Short',
  dedicado: 'video dedicado de YouTube',
  integracion: 'integración en un video de YouTube',
};

export function deliverablePromptName(kind: string): string {
  return DELIVERABLE_PROMPT_NAMES[kind] ?? kind.replace(/_/g, ' ');
}

/**
 * Lo que el brief ofrece, en una o dos frases para el prompt: los
 * formatos (solo esos) y la ventana de disponibilidad (fechas dentro de
 * ella). Vacío si el brief no dice ni lo uno ni lo otro. Las fechas van
 * en ISO (AAAA-MM-DD): el modelo no confunde día y mes.
 */
export function briefOfferLines(brief: {
  deliverables?: readonly string[] | null;
  availabilityFrom?: string | null;
  availabilityTo?: string | null;
}): string[] {
  const lines: string[] = [];
  const kinds = [...new Set((brief.deliverables ?? []).map(deliverablePromptName))];
  if (kinds.length > 0) {
    lines.push(`Formatos que ofrece el creador: ${kinds.join(', ')}. Si propones una colaboración, propón solo estos formatos.`);
  }
  const from = brief.availabilityFrom ?? null;
  const to = brief.availabilityTo ?? null;
  if (from || to) {
    const ventana = from && to ? `del ${from} al ${to}` : from ? `desde el ${from}` : `hasta el ${to}`;
    lines.push(`Disponible para campañas ${ventana}. Si propones fechas, que caigan dentro de esa ventana; nunca fuera de ella.`);
  }
  return lines;
}
