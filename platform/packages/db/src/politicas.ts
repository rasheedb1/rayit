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
 *   col = current_workspace_id()      el inquilino de la transacción,
 *                                     si col es la columna de inquilino
 *   col = current_user_id()           la persona de la transacción, si
 *                                     col la nombra (ver RONDA 5)
 *   EXISTS (SELECT … FROM padre p     el padre decide, porque su RLS
 *           WHERE p.x = tabla.y …)    corre dentro de la subconsulta;
 *                                     exige que el padre esté aislado
 *                                     y que la subconsulta esté
 *                                     CORRELACIONADA con la fila por
 *                                     una CLAVE AJENA de verdad (abajo)
 *
 * LA CORRELACIÓN TIENE QUE SER UNA CLAVE AJENA (ronda 4)
 * ------------------------------------------------------
 * Hasta la ronda 3 bastaba con que el WHERE igualara CUALQUIER columna
 * de la subconsulta con CUALQUIER columna de la fila. Medido:
 * `USING (EXISTS (SELECT 1 FROM deal d WHERE d.name = zz.nota))` pasaba
 * en verde, y B leía toda fila de A cuya nota coincidiera con el nombre
 * de algún deal suyo; con `membership.user_id = t.created_by`, B leía
 * las filas de otros workspaces de una persona compartida. Ahora el par
 * cuenta solo si es una de estas tres cosas, según pg_constraint:
 *
 *   tabla.col → padre.pcol    la fila apunta a su padre (0018, 0024 §6)
 *   padre.pcol → tabla.col    un hijo visible apunta a la fila
 *                             (app_user_read: una membresía mía que la
 *                             nombra). Lo que impide fabricar ese hijo es
 *                             el disparador de 0025 §3: un hijo solo
 *                             puede nombrar una fila que ya se ve.
 *   la clave de inquilino     workspace_id u owner_workspace_id en los
 *     en los dos lados        dos lados: el padre dice de qué inquilino
 *                             es la fila
 *
 * LOS PADRES CON FILAS GLOBALES (ronda 4)
 * ---------------------------------------
 * Un padre «con globales» (pipeline_stage, external_post, company…) deja
 * ver a todos sus filas sin dueño. Heredar eso está bien para un dato
 * global (external_post_score cuelga de un post que el radar vio), pero
 * no para una fila que tiene inquilino propio: `zz.stage_id → etapa
 * global` la abriría a todos los workspaces aunque lleve workspace_id.
 * Así que, si la tabla de la política tiene su propia columna de
 * inquilino, un EXISTS sobre un padre con globales no aísla por sí solo:
 * hace falta además comparar esa columna con el inquilino (en un AND),
 * o declarar la tabla en HIJAS_CON_GLOBALES_DECLARADAS con su motivo.
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
 * RONDA 5: LO QUE LA FORMA NO DECÍA
 * ---------------------------------
 * Cuatro formas pasaban por cerradas sin serlo. Todas reproducidas por
 * los revisores con la guardia en verde:
 *
 *   · La LISTA del SELECT de un EXISTS. `EXISTS (SELECT count(*) FROM
 *     deal d WHERE d.id = t.deal_id)` es verdadero para TODA fila: un
 *     agregado sin GROUP BY devuelve siempre una fila. Ahora la lista
 *     tiene que ser una constante (`SELECT 1`), y cualquier GROUP BY,
 *     HAVING, UNION, INTERSECT, EXCEPT, LIMIT, OFFSET, FETCH o WINDOW en
 *     la subconsulta la deja «abierta».
 *
 *   · QUÉ columna se compara con el inquilino. `(nota)::uuid =
 *     current_workspace_id()` sobre una tabla con workspace_id pasaba en
 *     verde, y B leía la fila de A. Ahora `col = current_workspace_id()`
 *     solo aísla si col es la columna de inquilino de la tabla (o `id`
 *     en workspace, o una clave ajena a workspace(id) en una tabla sin
 *     columna de inquilino).
 *
 *   · `col = current_user_id()` aísla por PERSONA, no por inquilino. En
 *     una tabla con workspace_id, `created_by = current_user_id()` abre a
 *     quien está en dos workspaces las filas del otro, leyendo desde B.
 *     Ahora col tiene que ser `id` en app_user o una clave ajena a
 *     app_user(id); y en una tabla con columna de inquilino hace falta
 *     además el término del inquilino en un AND, o declarar la columna
 *     en AISLADAS_POR_PERSONA_DECLARADAS con su motivo (membership: cada
 *     persona lee sus membresías, que es la lista de sus workspaces).
 *     La otra llave de la persona es su correo verificado (CIM-3,
 *     0027): `email = current_user_email()` aísla SOLO en app_user y
 *     SOLO sobre `email`, que es único en la tabla (app_user_email_key)
 *     y lo fija la sesión con lo que Supabase verificó. Es la misma fila
 *     que `id = current_user_id()`, dicha antes de saber el id. Sobre
 *     cualquier otra columna o tabla, esa forma no aísla.
 *
 *   · La rama «col IS NULL» abre la fila a todos, y la fila puede NOMBRAR
 *     algo privado por OTRA clave ajena. brand_account_snapshot sin
 *     campaña enseñaba el company_id, el handle y los seguidores de
 *     empresas que quien lee no ve. Ahora una rama «IS NULL» aceptada en
 *     lectura tiene que correlacionar, con un EXISTS en su AND, cada
 *     otra clave ajena de la tabla hacia una tabla con RLS. Y las
 *     columnas de esas ramas se devuelven (`nulos`), para que la guardia
 *     compruebe que borrar el padre no las ponga a NULL (ON DELETE SET
 *     NULL publicaría la fila).
 *
 * Esto no demuestra que una política sea CORRECTA —eso lo prueban los
 * ataques de test/rls.test.ts, workspace por workspace—: impide que una
 * abierta pase por cerrada.
 */

/** Qué lado de la política se evalúa: USING de un SELECT, o todo lo que escribe o toca filas. */
export type Lado = 'lectura' | 'escritura';

/** Cómo aísla una tabla sus lecturas, que es lo que hereda un EXISTS sobre ella. */
export type AislamientoDeLectura = 'estricto' | 'con-globales' | 'no';

/** Una clave ajena de una sola columna: `tabla.col → padre`. */
export interface ReferenciaDeTabla {
  col: string;
  padre: string;
}

export interface ContextoDePolitica {
  /** La tabla de la política: la subconsulta tiene que correlacionarse con ella. */
  tabla: string;
  lado: Lado;
  /** Cómo aísla sus lecturas otra tabla (para los EXISTS). */
  aislamientoDe: (tabla: string) => AislamientoDeLectura;
  /** ¿Hay una clave ajena de una sola columna `hija.col → padre.pcol`? (pg_constraint) */
  esReferencia: (hija: string, col: string, padre: string, pcol: string) => boolean;
  /** Las columnas de inquilino que lleva la tabla (workspace_id, owner_workspace_id). */
  inquilinoDe: (tabla: string) => readonly string[];
  /** ¿Está declarada como hija que hereda a propósito las filas globales de su padre? */
  hijaConGlobalesDeclarada: (tabla: string) => boolean;
  /**
   * Las claves ajenas de una columna de la tabla hacia tablas CON RLS: lo
   * que una fila global puede nombrar y quien la lee quizá no ve.
   */
  referenciasConRls: (tabla: string) => readonly ReferenciaDeTabla[];
  /** ¿Está declarada `tabla.col = current_user_id()` como aislamiento por persona? */
  personaDeclarada: (tabla: string, col: string) => boolean;
}

/** Las columnas que dicen de qué inquilino es una fila. */
export const COLUMNAS_DE_INQUILINO: readonly string[] = ['workspace_id', 'owner_workspace_id'];

type Resultado =
  /** `nulos`: las columnas de las ramas «IS NULL» que se aceptaron (la fila global). */
  | { t: 'aisla'; claves: Set<string>; globales: boolean; nulos: Set<string> }
  /** `correlaciones`: las columnas que los EXISTS de su AND correlacionan con un padre. */
  | { t: 'nulo'; col: string; correlaciones: Set<string> }
  /** `col = current_user_id()` en una tabla con inquilino: estrecha, no aísla sola. */
  | { t: 'persona'; col: string; trozo: string }
  | { t: 'abierta'; trozo: string };

/** El veredicto sobre una expresión entera. */
export type Veredicto =
  | { aisla: true; globales: boolean; nulos: string[] }
  | { aisla: false; trozo: string };

const IDENT = '[a-z_][a-z0-9_$]*';
/** Una columna, calificada o no, con un cast opcional: `workspace_id`, `c.id`, `(id)::text`. */
const COLUMNA = `\\(?(?:${IDENT}\\.)?(${IDENT})\\)?(?:::${IDENT}(?: ${IDENT})*)?`;
const CAST = `(?:::${IDENT}(?: ${IDENT})*)?`;
/** El inquilino de la transacción, con un cast opcional. */
const DEL_WORKSPACE = `\\(?current_workspace_id\\(\\)\\)?${CAST}`;
/** La persona de la transacción, con un cast opcional. */
const DE_LA_PERSONA = `\\(?current_user_id\\(\\)\\)?${CAST}`;
const COL_IGUAL_WORKSPACE = new RegExp(`^${COLUMNA} = ${DEL_WORKSPACE}$`);
const WORKSPACE_IGUAL_COL = new RegExp(`^${DEL_WORKSPACE} = ${COLUMNA}$`);
const COL_IGUAL_PERSONA = new RegExp(`^${COLUMNA} = ${DE_LA_PERSONA}$`);
const PERSONA_IGUAL_COL = new RegExp(`^${DE_LA_PERSONA} = ${COLUMNA}$`);
/** El correo verificado de la sesión (0027), con un cast opcional. */
const DEL_CORREO = `\\(?current_user_email\\(\\)\\)?${CAST}`;
const COL_IGUAL_CORREO = new RegExp(`^${COLUMNA} = ${DEL_CORREO}$`);
const CORREO_IGUAL_COL = new RegExp(`^${DEL_CORREO} = ${COLUMNA}$`);
const COL_ES_NULA = new RegExp(`^(${IDENT}) IS NULL$`);
const CORRELACION = new RegExp(`^(${IDENT})\\.(${IDENT}) = (${IDENT})\\.(${IDENT})$`);
/**
 * La lista de un EXISTS que se acepta: una constante. `count(*)`,
 * `max(x)` o cualquier cosa con paréntesis puede ser un agregado, y un
 * agregado sin GROUP BY devuelve siempre UNA fila: el EXISTS vale true
 * para todas.
 */
const LISTA_CONSTANTE = /^(?:\d+|'[^']*'(?:::[a-z_ ]+)?|true|false|NULL)$/;
/**
 * Lo que cambia cuántas filas devuelve la subconsulta sin pasar por el
 * WHERE: HAVING sin GROUP BY agrega, UNION suma otra consulta sin
 * correlación, y los demás no tienen por qué estar en una política.
 */
const CLAUSULAS_PROHIBIDAS = /\b(?:GROUP BY|HAVING|UNION|INTERSECT|EXCEPT|LIMIT|OFFSET|FETCH|WINDOW)\b/;

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

/** La expresión con el contenido de las cadenas borrado: para buscar palabras clave sin mirar dentro de un literal. */
function sinCadenas(s: string): string {
  let out = '';
  let enCadena = false;
  for (const ch of s) {
    if (ch === "'") {
      enCadena = !enCadena;
      out += ch;
      continue;
    }
    out += enCadena ? ' ' : ch;
  }
  return out;
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

const abierta = (trozo: string): Resultado => ({ t: 'abierta', trozo });
const aisla = (claves: Iterable<string>, globales: boolean, nulos: Iterable<string> = []): Resultado => ({
  t: 'aisla',
  claves: new Set(claves),
  globales,
  nulos: new Set(nulos),
});

/**
 * La forma `EXISTS (SELECT 1 FROM padre p WHERE p.x = tabla.y …)`:
 * la columna de la fila con la que se correlaciona, y si el padre tiene
 * filas globales. `null` si no es un EXISTS; 'abierta' si lo es pero no
 * aísla (sin tabla, sin correlación, sobre una tabla sin RLS, con un
 * agregado o una cláusula que cambia cuántas filas devuelve).
 */
function leerExiste(s: string, ctx: ContextoDePolitica): { col: string; globales: boolean } | 'abierta' | null {
  if (!s.startsWith('EXISTS (')) return null;
  const abre = s.indexOf('(');
  if (cierre(s, abre) !== s.length - 1) return null;
  const dentro = s.slice(abre + 1, -1).trim();
  if (!dentro.startsWith('SELECT ')) return 'abierta';
  if (CLAUSULAS_PROHIBIDAS.test(sinCadenas(dentro))) return 'abierta';
  const [lista, resto] = partir(dentro.slice('SELECT '.length), 'FROM');
  if (resto === undefined) return 'abierta'; // EXISTS (SELECT 1): sin tabla, siempre verdadero
  if (!lista || !LISTA_CONSTANTE.test(lista)) return 'abierta'; // count(*) sin GROUP BY: una fila siempre
  const [from, where] = partir(resto, 'WHERE');
  if (!from || where === undefined) return 'abierta'; // sin WHERE: no está correlacionado
  const tablas = tablasDelFrom(from);
  if (!tablas.length) return 'abierta';

  // Cada tabla de la subconsulta tiene que estar aislada ella misma: un
  // EXISTS sobre un catálogo sin RLS es verdadero para cualquiera.
  const minimo: AislamientoDeLectura = ctx.lado === 'lectura' ? 'con-globales' : 'estricto';
  let globales = false;
  for (const { tabla } of tablas) {
    const a = ctx.aislamientoDe(tabla);
    if (ORDEN[a] < ORDEN[minimo]) return 'abierta';
    if (a === 'con-globales') globales = true;
  }

  // Y correlacionada con la fila POR UNA CLAVE AJENA: uno de los
  // términos del AND de su WHERE tiene que igualar una columna de la
  // subconsulta con una de la tabla de la política, y ese par tiene que
  // ser una referencia real (ver «LA CORRELACIÓN…» arriba). Sin
  // correlación, `EXISTS (SELECT 1 FROM deal)` es «¿tengo algún deal?»;
  // con una correlación cualquiera, `d.name = t.nota` es «¿tengo algún
  // deal que se llame como tu nota?». Las dos abren filas ajenas.
  const tablaDe = new Map(tablas.map((x) => [x.alias, x.tabla] as const));
  const inquilino = new Set(COLUMNAS_DE_INQUILINO);
  const correlaciona = (col: string, alias: string, pcol: string): boolean => {
    const padre = tablaDe.get(alias);
    if (!padre) return false;
    return (
      ctx.esReferencia(ctx.tabla, col, padre, pcol) ||
      ctx.esReferencia(padre, pcol, ctx.tabla, col) ||
      (inquilino.has(col) && inquilino.has(pcol))
    );
  };
  for (const termino of partir(sinParentesis(where), 'AND')) {
    const m = CORRELACION.exec(sinParentesis(termino));
    if (!m) continue;
    const [, q1, c1, q2, c2] = m;
    if (q1 === ctx.tabla && correlaciona(c1!, q2!, c2!)) return { col: c1!, globales };
    if (q2 === ctx.tabla && correlaciona(c2!, q1!, c1!)) return { col: c2!, globales };
  }
  return 'abierta';
}

/** Un EXISTS como término: aísla, no aísla, o no es un EXISTS (null). */
function existe(s: string, ctx: ContextoDePolitica): Resultado | null {
  const e = leerExiste(s, ctx);
  if (e === null) return null;
  if (e === 'abierta') return abierta(s);
  // Un padre con filas globales no basta para una fila con inquilino
  // propio (ver «LOS PADRES CON FILAS GLOBALES» arriba). Dentro de un
  // AND con `workspace_id = current_workspace_id()` la política sigue
  // aislando: el AND toma el término estricto.
  if (e.globales && ctx.inquilinoDe(ctx.tabla).length > 0 && !ctx.hijaConGlobalesDeclarada(ctx.tabla)) {
    return abierta(s);
  }
  return aisla([e.col], e.globales);
}

/** ¿Dice `col` de qué inquilino es la fila? */
function esColumnaDeInquilino(col: string, ctx: ContextoDePolitica): boolean {
  const propias = ctx.inquilinoDe(ctx.tabla);
  if (propias.length) return propias.includes(col);
  if (ctx.tabla === 'workspace') return col === 'id';
  return ctx.esReferencia(ctx.tabla, col, 'workspace', 'id');
}

/** ¿Nombra `col` a una persona? */
function esColumnaDePersona(col: string, ctx: ContextoDePolitica): boolean {
  if (ctx.tabla === 'app_user') return col === 'id';
  return ctx.esReferencia(ctx.tabla, col, 'app_user', 'id');
}

function atomo(s: string, ctx: ContextoDePolitica): Resultado {
  const ex = existe(s, ctx);
  if (ex) return ex;

  const ws = COL_IGUAL_WORKSPACE.exec(s) ?? WORKSPACE_IGUAL_COL.exec(s);
  if (ws) {
    // `(nota)::uuid = current_workspace_id()` menciona al inquilino y no
    // aísla nada: la fila de A con la nota de B se ve desde B.
    return esColumnaDeInquilino(ws[1]!, ctx) ? aisla([ws[1]!], false) : abierta(s);
  }

  const persona = COL_IGUAL_PERSONA.exec(s) ?? PERSONA_IGUAL_COL.exec(s);
  if (persona) {
    const col = persona[1]!;
    if (!esColumnaDePersona(col, ctx)) return abierta(s);
    // En una tabla con inquilino, la persona sola abre las filas de sus
    // OTROS workspaces a quien lee desde este.
    if (ctx.inquilinoDe(ctx.tabla).length && !ctx.personaDeclarada(ctx.tabla, col)) {
      return { t: 'persona', col, trozo: s };
    }
    return aisla([col], false);
  }

  // El correo verificado solo nombra a una persona en app_user.email
  // (único): ahí es la misma fila que `id = current_user_id()`.
  const correo = COL_IGUAL_CORREO.exec(s) ?? CORREO_IGUAL_COL.exec(s);
  if (correo) return ctx.tabla === 'app_user' && correo[1] === 'email' ? aisla(['email'], false) : abierta(s);

  const nula = COL_ES_NULA.exec(s);
  if (nula) return { t: 'nulo', col: nula[1]!, correlaciones: new Set() };
  return abierta(s);
}

function analizar(expr: string, ctx: ContextoDePolitica): Resultado {
  const s = sinParentesis(expr);

  const ramas = partir(s, 'OR');
  if (ramas.length > 1) {
    const rs = ramas.map((r) => analizar(r, ctx));
    const claves = new Set<string>();
    for (const r of rs) if (r.t === 'aisla') for (const c of r.claves) claves.add(c);
    let globales = false;
    const nulos = new Set<string>();
    for (const r of rs) {
      if (r.t === 'aisla') {
        globales ||= r.globales;
        for (const c of r.nulos) nulos.add(c);
        continue;
      }
      if (r.t === 'nulo') {
        // «sin dueño, o mío»: solo en lectura, y solo sobre la misma
        // columna que otra rama compara con el inquilino.
        if (ctx.lado !== 'lectura' || !claves.has(r.col)) return abierta(`${r.col} IS NULL`);
        // Y la fila sin dueño no puede nombrar lo que quien lee no ve:
        // cada otra clave ajena hacia una tabla con RLS, correlacionada
        // con un EXISTS en el AND de esta rama.
        const sueltas = ctx
          .referenciasConRls(ctx.tabla)
          .filter((x) => x.col !== r.col && !r.correlaciones.has(x.col))
          .map((x) => `${x.col} → ${x.padre}`);
        if (sueltas.length) return abierta(`${r.col} IS NULL (la fila global nombra ${sueltas.join(', ')} sin mirar si se ve)`);
        globales = true;
        nulos.add(r.col);
        continue;
      }
      return r.t === 'abierta' ? r : abierta(r.trozo);
    }
    return aisla(claves, globales, nulos);
  }

  const terminos = partir(s, 'AND');
  if (terminos.length > 1) {
    const rs = terminos.map((r) => analizar(r, ctx));
    const estrictos = rs.filter((r): r is Extract<Resultado, { t: 'aisla' }> => r.t === 'aisla' && !r.globales);
    if (estrictos.length) {
      // El AND solo estrecha: con un término estricto la fila es de un
      // inquilino, y las ramas «IS NULL» de dentro no la hacen global.
      const claves = new Set<string>();
      for (const r of estrictos) for (const c of r.claves) claves.add(c);
      return aisla(claves, false);
    }
    // `owner IS NULL AND source = … AND EXISTS (padre)` sigue siendo una
    // rama «sin dueño»: el AND la estrecha, no la abre. Se anota qué
    // columnas correlaciona con un padre, para la regla del OR.
    const nulo = rs.find((r): r is Extract<Resultado, { t: 'nulo' }> => r.t === 'nulo');
    if (nulo) {
      const correlaciones = new Set<string>();
      for (const termino of terminos) {
        const e = leerExiste(sinParentesis(termino), ctx);
        if (e && e !== 'abierta') correlaciones.add(e.col);
      }
      return { t: 'nulo', col: nulo.col, correlaciones };
    }
    const conGlobales = rs.find((r) => r.t === 'aisla');
    if (conGlobales) return conGlobales;
    const persona = rs.find((r) => r.t === 'persona');
    if (persona) return abierta(persona.trozo);
    return abierta(s);
  }

  return atomo(s, ctx);
}

/**
 * Los términos del AND de más afuera, sin paréntesis: el predicado de un
 * índice parcial (`((email IS NOT NULL) AND (owner_workspace_id IS
 * NULL))`) → ['email IS NOT NULL', 'owner_workspace_id IS NULL']. Un OR
 * de más afuera queda como UN término: no estrecha nada.
 */
export function terminosDelAnd(expr: string): string[] {
  return partir(sinParentesis(normalizar(expr)), 'AND').map(sinParentesis);
}

/**
 * ¿Aísla esta expresión, por sí sola? `null` es una expresión que no
 * existe: una política FOR INSERT sin WITH CHECK, que equivale a `true`.
 */
export function veredicto(expr: string | null, ctx: ContextoDePolitica): Veredicto {
  if (expr === null || expr.trim() === '') return { aisla: false, trozo: '(sin expresión: equivale a true)' };
  const r = analizar(normalizar(expr), ctx);
  if (r.t === 'aisla') return { aisla: true, globales: r.globales, nulos: [...r.nulos].sort() };
  if (r.t === 'nulo') return { aisla: false, trozo: `${r.col} IS NULL` };
  return { aisla: false, trozo: r.trozo };
}
