/**
 * ¿Una cifra escrita dice lo mismo que su claim? (VEN-12)
 */
import type { SalesClaim } from '../claims.ts';
import type { FigureHit } from './hit.ts';

/** Tolerancia de una cifra redondeada HACIA ABAJO frente al dato («400 mil» por 412.000; «6,7×» por 6,72). */
export const FIGURE_TOLERANCE = 0.05;

/**
 * ¿La cifra escrita dice lo mismo que el claim, con redondeo? Se acepta
 * de dos maneras, y ninguna infla el dato:
 *
 *   · redondeada hacia abajo, hasta un 5 % («115 mil» o «110 mil» por
 *     115.446: «más de 110 mil» es verdad);
 *   · el redondeo del dato a la precisión con que está escrita, sin
 *     alejarse más de un 5 % («58 %» por 0,576; «1,2 M» por 1.180.000;
 *     «6,7×» por 6,66): la cifra que da Intl al formatear el claim
 *     siempre pasa; «x3» por 3,4× no (redondeo, pero un 12 % de más).
 *
 * «120 mil» por 115.446 no pasa: escrito a miles, el dato es 115 mil, y
 * 120 es redondearlo hacia arriba (ronda 5).
 */
export function figureMatchesClaim(hit: FigureHit, claim: SalesClaim): boolean {
  // Un puesto («#1», «top 3») no lo respalda ninguna cifra del perfil.
  if (claim.value === null || hit.kind === 'rank') return false;
  const target = claim.value;
  return hit.values.some((v, i) => {
    if (target === 0) return v === 0;
    const size = Math.abs(target);
    const eps = size * 1e-9;
    // Hacia abajo (hacia el cero), hasta la tolerancia.
    if (Math.abs(v) <= size + eps && Math.sign(v) === Math.sign(target) && (size - Math.abs(v)) / size <= FIGURE_TOLERANCE) return true;
    // El redondeo del dato a la precisión con que se escribió, y cerca de él: «x3» no es 3,4×.
    const step = hit.steps?.[i];
    return step !== undefined && step > 0 && Math.abs(v - target) <= step / 2 + eps && Math.abs(v - target) / size <= FIGURE_TOLERANCE;
  });
}
