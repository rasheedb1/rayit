/**
 * La forma de una cifra encontrada en un texto (VEN-12). Vive aparte para
 * que los detectores de figures/ y claims.ts la compartan sin ciclos.
 */

/** Una cifra encontrada en el texto, con sus lecturas posibles. */
export interface FigureHit {
  /** El texto de la cifra, tal cual («115.446», «37 %», «6,7x», «400 mil»). */
  raw: string;
  start: number;
  end: number;
  /**
   * Las lecturas numéricas posibles. «1.240» es 1240 en español y 1,24 en
   * inglés: se guardan las dos y basta con que una coincida con el claim.
   * Un porcentaje se lee como proporción (37 % → 0,37).
   */
  values: number[];
  /**
   * Con qué precisión está escrita cada lectura, en paralelo a `values`:
   * el valor del último dígito que se escribió, con los ceros finales
   * como significativos («120 mil» → 1.000; «57,6 %» → 0,001; «1,2 M» →
   * 100.000). Con ella se sabe si una cifra es el redondeo del dato o
   * lo infla (figureMatchesClaim). Sin ella (las cifras en palabras, las
   * proporciones), solo se acepta el redondeo hacia abajo.
   */
  steps?: number[];
  /**
   * 'rank' es un puesto («#1», «top 3», «número uno»): ninguna cifra del
   * perfil lo respalda (On Cue no guarda rankings), así que nunca coincide
   * con un claim y siempre sale como «cifra sin origen».
   */
  kind: 'plain' | 'percent' | 'multiple' | 'scaled' | 'rank';
}
