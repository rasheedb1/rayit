/**
 * Conversión de valores crudos sin inventar ceros: lo que no es un
 * número (o una cadena numérica, como en YouTube) se vuelve null.
 */

export function intOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
  return null;
}

export function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Segundos UNIX → Date, o null. */
export function dateFromUnixS(v: unknown): Date | null {
  const n = intOrNull(v);
  return n === null ? null : new Date(n * 1000);
}

export function dateFromIso(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Porcentaje 0..100 → fracción 0..1 (con cuatro decimales de sobra para numeric(6,5)). */
export function fractionFromPercent(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n * 1_000_000) / 100_000_000;
}

export function extractHashtags(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w&])#([\p{L}\p{N}_]+)/gu)) out.add(m[1]!.toLowerCase());
  return [...out];
}

export function extractMentions(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w])@([\p{L}\p{N}_.]+[\p{L}\p{N}_])/gu)) out.add(m[1]!.toLowerCase());
  return [...out];
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
