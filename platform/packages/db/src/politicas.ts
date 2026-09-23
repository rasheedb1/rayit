/**
 * Qué DICE una política de RLS, leída de pg_get_expr.
 *
 * La guardia de src/esquema.ts no puede conformarse con contar
 * políticas, ni con que «alguna» mencione current_workspace_id(): las
 * políticas PERMISIVAS de una tabla se combinan con OR, así que basta
 * UNA abierta para anular todas las demás. Medido en la ronda 2:
 *
 *   tabla aislada + CREATE POLICY coladera FOR SELECT USING (1 = 1)
 *   una sola política USING (current_workspace_id() IS NOT NULL)
 *   FOR SELECT aislada + FOR DELETE USING (workspace_id IS NOT NULL)
 *
 * Las tres pasaban en verde y en las tres el workspace B leía —o
 * BORRABA— las filas de A. Por eso aquí se evalúa CADA política, por
 * sí sola, y se exige que su expresión aísle entera.
 *
 * QUÉ CUENTA COMO AISLAR
 * ----------------------
 * Una expresión aísla si es una de estas formas, o una combinación de
 * ellas con AND y OR en la que CADA rama del OR aísla:
 *
 *   col = current_workspace_id()      el inquilino de la transacción
 *   col = current_user_id()           la persona de la transacción
 *   EXISTS (SELECT … FROM padre p     el padre decide, porque su RLS
 *           WHERE p.x = tabla.y …)    corre dentro de la subconsulta;
 *                                     exige que el padre esté aislado
 *                                     y que la subconsulta esté
 *                                     CORRELACIONADA con la fila
 *
 * En un AND basta con que un término aísle (el AND solo estrecha). En un
 * OR tienen que aislar todos, con UNA excepción, y solo en lectura:
 *
 *   col IS NULL                       la fila global de un catálogo con
 *                                     dueño (pipeline_stage, company,
 *                                     external_post…). Se acepta si
 *                                     `col` es la MISMA columna que otra
 *                                     rama del OR compara con el
 *                                     inquilino: «sin dueño, o mía».
 *
 * En escritura esa rama no vale: «o sin dueño» en un WITH CHECK es
 * poder crear filas globales, y en el USING de un UPDATE o un DELETE es
 * poder tocar las de todos.
 *
 * Y todo lo demás NO aísla: `true`, `1 = 1`, `current_workspace_id() IS
 * NOT NULL` (vale para cualquier fila en cuanto hay workspace), `col IS
 * NOT NULL`, `EXISTS (SELECT 1)` (sin correlación), un EXISTS sobre un
 * catálogo sin RLS, una comparación con un literal. No se intenta
 * entender SQL arbitrario: lo que no se reconoce no aísla, y si es
 * abierto a propósito se declara en POLITICAS_ABIERTAS_DECLARADAS con su
 * motivo.
 *
 * Esto no demuestra que una política sea CORRECTA —eso lo prueban los
 * ataques de test/rls.test.ts, workspace por workspace—: impide que una
 * abierta pase por cerrada.
 */

/** Qué lado de la política se evalúa: USING de un SELECT, o todo lo que escribe o toca filas. */
export type Lado = 'lectura' | 'escritura';

/** Cómo aísla una tabla sus lecturas, que es lo que hereda un EXISTS sobre ella. */
export type AislamientoDeLectura = 'estricto' | 'con-globales' | 'no';

export interface ContextoDePolitica {
  /** La tabla de la política: la subconsulta tiene que correlacionarse con ella. */
  tabla: string;
  lado: Lado;
  /** Cómo aísla sus lecturas otra tabla (para los EXISTS). */
  aislamientoDe: (tabla: string) => AislamientoDeLectura;
}

type Resultado =
  | { t: 'aisla'; claves: Set<string>; globales: boolean }
  | { t: 'nulo'; col: string }
  | { t: 'abierta'; trozo: string };

/** El veredicto sobre una expresión entera. */
export type Veredicto =
  | { aisla: true; globales: boolean }
  | { aisla: false; trozo: string };

const IDENT = '[a-z_][a-z0-9_$]*';
/** Una columna, calificada o no, con un cast opcional: `workspace_id`, `c.id`, `(id)::text`. */
const COLUMNA = `\\(?(?:${IDENT}\\.)?(${IDENT})\\)?(?:::${IDENT}(?: ${IDENT})*)?`;
/** El inquilino o la persona de la transacción, con un cast opcional. */
const INQUILINO = `\\(?current_(?:workspace|user)_id\\(\\)\\)?(?:::${IDENT}(?: ${IDENT})*)?`;
const COL_IGUAL_INQUILINO = new RegExp(`^${COLUMNA} = ${INQUILINO}$`);
const INQUILINO_IGUAL_COL = new RegExp(`^${INQUILINO} = ${COLUMNA}$`);
const COL_ES_NULA = new RegExp(`^(${IDENT}) IS NULL$`);
const CORRELACION = new RegExp(`^(${IDENT})\\.(${IDENT}) = (${IDENT})\\.(${IDENT})$`);

/** Espacios colapsados fuera de las cadenas: pg_get_expr parte los EXISTS en varias líneas. */
export function normalizar(expr: string): string {
  let out = '';
  let enCadena = false;
  let espacio = false;
  for (const ch of expr) {
    if (ch === "'") enCadena = !enCadena;
    if (!enCadena && /\s/.test(ch)) {
      espacio = true;
      continue;
    }
    if (espacio && out !== '') out += ' ';
    espacio = false;
    out += ch;
  }
  // `EXISTS ( SELECT` → `EXISTS (SELECT`, `x )` → `x)`: la forma que
  // escribe pg_get_expr no siempre es simétrica.
  return out.replace(/\( /g, '(').replace(/ \)/g, ')');
}

/** El índice del paréntesis que cierra el que abre en `desde`, o -1. */
function cierre(s: string, desde: number): number {
  let prof = 0;
  let enCadena = false;
  for (let i = desde; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") enCadena = !enCadena;
    if (enCadena) continue;
    if (ch === '(') prof++;
    else if (ch === ')') {
      prof--;
      if (prof === 0) return i;
    }
  }
  return -1;
}

/** Quita los paréntesis que envuelven la expresión entera, los que haya. */
function sinParentesis(s: string): string {
  let e = s.trim();
  while (e.startsWith('(') && cierre(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

/** Parte por un operador (` OR `, ` AND `, ` FROM `…) en la profundidad cero, fuera de cadenas. */
function partir(s: string, op: string): string[] {
  const token = ` ${op} `;
  const trozos: string[] = [];
  let prof = 0;
  let enCadena = false;
  let inicio = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") enCadena = !enCadena;
    if (enCadena) continue;
    if (ch === '(') prof++;
    else if (ch === ')') prof--;
    else if (prof === 0 && s.startsWith(token, i)) {
      trozos.push(s.slice(inicio, i));
      inicio = i + token.length;
      i += token.length - 1;
    }
  }
  trozos.push(s.slice(inicio));
  return trozos.map((x) => x.trim());
}

/** Las tablas (y sus alias) de un FROM sencillo: `a x`, `a x JOIN b y ON (…)`, `a, b`. */
function tablasDelFrom(from: string): Array<{ tabla: string; alias: string }> {
  const piezas = partir(from, ',').flatMap((p) =>
    p.split(/\s+(?:(?:LEFT|RIGHT|FULL|INNER|CROSS)\s+)?(?:OUTER\s+)?JOIN\s+/),
  );
  const out: Array<{ tabla: string; alias: string }> = [];
  for (const pieza of piezas) {
    const m = new RegExp(`^(?:public\\.)?(${IDENT})(?: (?:AS )?(${IDENT}))?`).exec(pieza.trim());
    if (!m) return [];
    const tabla = m[1]!;
    const alias = m[2] && m[2] !== 'ON' ? m[2] : tabla;
    out.push({ tabla, alias });
  }
  return out;
}

const ORDEN: Record<AislamientoDeLectura, number> = { no: 0, 'con-globales': 1, estricto: 2 };

/** `EXISTS (SELECT … FROM padre p WHERE p.x = tabla.y …)`, o null si no tiene esa forma. */
function existe(s: string, ctx: ContextoDePolitica): Resultado | null {
  if (!s.startsWith('EXISTS (')) return null;
  const abre = s.indexOf('(');
  if (cierre(s, abre) !== s.length - 1) return null;
  const dentro = s.slice(abre + 1, -1).trim();
  if (!dentro.startsWith('SELECT ')) return { t: 'abierta', trozo: s };
  const [, resto] = partir(dentro, 'FROM');
  if (resto === undefined) return { t: 'abierta', trozo: s }; // EXISTS (SELECT 1): sin tabla, siempre verdadero
  const [from, where] = partir(resto, 'WHERE');
  if (!from || where === undefined) return { t: 'abierta', trozo: s }; // sin WHERE: no está correlacionado
  const tablas = tablasDelFrom(from);
  if (!tablas.length) return { t: 'abierta', trozo: s };

  // Cada tabla de la subconsulta tiene que estar aislada ella misma: un
  // EXISTS sobre un catálogo sin RLS es verdadero para cualquiera.
  const minimo: AislamientoDeLectura = ctx.lado === 'lectura' ? 'con-globales' : 'estricto';
  let globales = false;
  for (const { tabla } of tablas) {
    const a = ctx.aislamientoDe(tabla);
    if (ORDEN[a] < ORDEN[minimo]) return { t: 'abierta', trozo: s };
    if (a === 'con-globales') globales = true;
  }

  // Y correlacionada con la fila: uno de los términos del AND de su
  // WHERE tiene que igualar una columna de la subconsulta con una de la
  // tabla de la política. Sin eso, `EXISTS (SELECT 1 FROM deal)` es
  // «¿tengo algún deal?», que abre la tabla entera a quien tenga uno.
  const alias = new Set(tablas.map((x) => x.alias));
  for (const termino of partir(sinParentesis(where), 'AND')) {
    const m = CORRELACION.exec(sinParentesis(termino));
    if (!m) continue;
    const [, q1, c1, q2, c2] = m;
    if (q1 === ctx.tabla && alias.has(q2!)) return { t: 'aisla', claves: new Set([c1!]), globales };
    if (q2 === ctx.tabla && alias.has(q1!)) return { t: 'aisla', claves: new Set([c2!]), globales };
  }
  return { t: 'abierta', trozo: s };
}

function atomo(s: string, ctx: ContextoDePolitica): Resultado {
  const ex = existe(s, ctx);
  if (ex) return ex;
  const igual = COL_IGUAL_INQUILINO.exec(s) ?? INQUILINO_IGUAL_COL.exec(s);
  if (igual) return { t: 'aisla', claves: new Set([igual[1]!]), globales: false };
  const nula = COL_ES_NULA.exec(s);
  if (nula) return { t: 'nulo', col: nula[1]! };
  return { t: 'abierta', trozo: s };
}

function analizar(expr: string, ctx: ContextoDePolitica): Resultado {
  const s = sinParentesis(expr);

  const ramas = partir(s, 'OR');
  if (ramas.length > 1) {
    const rs = ramas.map((r) => analizar(r, ctx));
    const claves = new Set<string>();
    for (const r of rs) if (r.t === 'aisla') for (const c of r.claves) claves.add(c);
    let globales = false;
    for (const r of rs) {
      if (r.t === 'aisla') {
        globales ||= r.globales;
        continue;
      }
      // «sin dueño, o mío»: solo en lectura, y solo sobre la misma
      // columna que otra rama compara con el inquilino.
      if (r.t === 'nulo' && ctx.lado === 'lectura' && claves.has(r.col)) {
        globales = true;
        continue;
      }
      return r.t === 'abierta' ? r : { t: 'abierta', trozo: `${r.col} IS NULL` };
    }
    return { t: 'aisla', claves, globales };
  }

  const terminos = partir(s, 'AND');
  if (terminos.length > 1) {
    const rs = terminos.map((r) => analizar(r, ctx));
    const estrictos = rs.filter((r): r is Extract<Resultado, { t: 'aisla' }> => r.t === 'aisla' && !r.globales);
    if (estrictos.length) {
      const claves = new Set<string>();
      for (const r of estrictos) for (const c of r.claves) claves.add(c);
      return { t: 'aisla', claves, globales: false };
    }
    const conGlobales = rs.find((r) => r.t === 'aisla');
    if (conGlobales) return conGlobales;
    // `owner IS NULL AND source = …` sigue siendo una rama «sin dueño»:
    // el AND la estrecha, no la abre.
    const nulo = rs.find((r) => r.t === 'nulo');
    if (nulo) return nulo;
    return { t: 'abierta', trozo: s };
  }

  return atomo(s, ctx);
}

/**
 * ¿Aísla esta expresión, por sí sola? `null` es una expresión que no
 * existe: una política FOR INSERT sin WITH CHECK, que equivale a `true`.
 */
export function veredicto(expr: string | null, ctx: ContextoDePolitica): Veredicto {
  if (expr === null || expr.trim() === '') return { aisla: false, trozo: '(sin expresión: equivale a true)' };
  const r = analizar(normalizar(expr), ctx);
  if (r.t === 'aisla') return { aisla: true, globales: r.globales };
  if (r.t === 'nulo') return { aisla: false, trozo: `${r.col} IS NULL` };
  return { aisla: false, trozo: r.trozo };
}
