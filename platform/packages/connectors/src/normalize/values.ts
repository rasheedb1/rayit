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

const FRACTION_SCALE = 1_000_000; // seis decimales: caben en numeric(7,6) y numeric(6,5)

/** Porcentaje 0..100 → fracción 0..1 con seis decimales. Para APIs que documentan porcentaje (YouTube). */
export function fractionFromPercent(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.round((n / 100) * FRACTION_SCALE) / FRACTION_SCALE;
}

/**
 * Para APIs que no dicen si mandan fracción o porcentaje (reels_skip_rate
 * de Instagram, percentage de TikTok Accounts): > 1 se toma como
 * porcentaje. Se confirma con el fixture grabado.
 */
export function fractionOrPercent(v: unknown): number | null {
  const n = numOrNull(v);
  if (n === null) return null;
  return n > 1 ? fractionFromPercent(n) : Math.round(n * FRACTION_SCALE) / FRACTION_SCALE;
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
