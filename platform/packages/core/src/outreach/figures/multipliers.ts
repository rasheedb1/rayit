/**
 * Los múltiplos (VEN-12): «x3», «×2», «3-fold», los puntos porcentuales
 * («5 pp») y los múltiplos en palabras («el triple», «duplicamos»). Son una
 * cifra siempre, por pequeños que sean.
 */

// Cifras que lo son SIEMPRE, por pequeñas que sean (no pasan por SMALL_COUNT_MAX):
/** Un multiplicador delante: «las ventas crecieron x3», «×2 en guardados». */
export const PREFIX_MULTIPLE_RE = /(?<![\p{L}\p{N}])[x×]\s?(\d+(?:[.,]\d+)?)(?![\p{L}\p{N}])/giu;
/** «3-fold», «10 fold». */
export const FOLD_RE = /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)[\s-]?fold(?![\p{L}])/giu;
/** Puntos porcentuales: «subió 5 pp», «3 puntos porcentuales». */
export const POINTS_RE = /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s?(?:pp|p\.\s?p\.|puntos porcentuales|percentage points)(?![\p{L}])/giu;

/** Los múltiplos en palabras: son una cifra siempre («el triple de views»). */
const MULTIPLIERS: Record<string, number> = {
  doble: 2, twice: 2, thrice: 3, twofold: 2, threefold: 3, fourfold: 4, fivefold: 5, tenfold: 10,
};
/**
 * Los verbos y adjetivos de múltiplo, por su raíz y no por una lista de
 * conjugaciones: «duplicamos», «triplicó», «duplicaste», «cuadruplicaron»,
 * «doubled», «tripling», «quadruple». Se comparan plegados (sin tildes).
 */
const MULTIPLIER_STEMS: Array<[RegExp, number]> = [
  // La «c» pasa a «qu» delante de «e»: «dupliqué», «dupliquemos», «cuadrupliqué» (ronda 5).
  [/^dupli(?:c|qu)/, 2], [/^tripli(?:c|qu)/, 3], [/^cuadrupli(?:c|qu)/, 4], [/^quintupli(?:c|qu)/, 5],
  [/^triple/, 3], [/^cuadruple/, 4], [/^quintuple/, 5],
  [/^doubl/, 2], [/^tripl/, 3], [/^quadrupl/, 4], [/^quintupl/, 5],
];

export function multiplierOf(w: string): number | null {
  if (w in MULTIPLIERS) return MULTIPLIERS[w]!;
  for (const [re, n] of MULTIPLIER_STEMS) if (re.test(w)) return n;
  return null;
}
