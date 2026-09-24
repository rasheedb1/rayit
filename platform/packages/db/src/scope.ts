/**
 * Alcance dentro de un workspace (ACC-6).
 *
 * La tenencia la garantiza RLS: una transacción con workspace fijado no
 * ve otro workspace, pase lo que pase. El ALCANCE es una capa de
 * producto encima: un miembro con filas en `membership_scope` (por
 * creador, por marca o por campaña) ve solo lo que cae en ellas. Sin
 * filas, ve todo el workspace. Lo aplica CADA consulta de
 * `queries/<modulo>.ts` componiendo `scopeFilter()` en su WHERE, y una
 * prueba por módulo (`test/alcance-*.test.ts`) recorre todas las
 * funciones exportadas para que ninguna se lo salte.
 *
 * Quién pregunta lo sabe la base: `scope_allows()` (migración
 * 0040_scope_allows; la tabla membership_scope es de 0034 §6) lee las filas de `current_workspace_id()` y
 * `current_user_id()`, que withWorkspace fija en la transacción. Ninguna
 * función recibe el alcance como parámetro.
 *
 * Semántica (docs/propuestas/ACC-6.md §0.3, D3):
 *   - Entre tipos se INTERSECTA: alcance por creador Y por marca es «las
 *     campañas de Camilo con la marca X».
 *   - Dentro de un tipo se UNE: dos filas de creador son «Camilo o Sofía».
 *   - Un ancla NULL nunca está en alcance: una campaña sin creator_id no
 *     es de nadie. Un nulo no es un cero.
 *   - Una tabla sin camino a un tipo (una cuenta conectada no es de una
 *     marca) declara `null` y se OCULTA a quien tenga alcance de ese tipo.
 *     Abrir por defecto sería una política de alcance que no se ve como
 *     un bug.
 */
import type { WorkspaceTx } from './client.ts';

/** membership_scope.scope_type (CHECK en 0034 §6). */
export const SCOPE_KINDS = ['creator', 'company', 'campaign'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * Un ancla uno-a-muchos: una expresión SQL que devuelve `uuid[]`
 * («las campañas de este post»). Cae en alcance si alguno de los ids cae.
 */
export interface ScopeMany {
  readonly any: string;
}

/**
 * Qué columna (o subconsulta) de la tabla raíz responde a cada tipo de
 * alcance. Los tres son obligatorios para que quien escribe la consulta
 * decida por cada uno: una expresión SQL `uuid`, un `ScopeMany`, o
 * `null` cuando la tabla no tiene camino a ese tipo (y se oculta a quien
 * tenga alcance de ese tipo).
 */
export type ScopeAnchors = Readonly<Record<ScopeKind, string | ScopeMany | null>>;

/**
 * «¿La persona de la transacción tiene alcance de este tipo?» Es una
 * subconsulta SIN correlación con la fila: el planificador la evalúa una
 * vez por consulta (InitPlan), y el OR de abajo no llega a evaluar ni el
 * ancla ni scope_allows() cuando no hay filas —que es siempre, en el
 * MVP—. Repite la primera mitad de scope_allows() a propósito: la
 * función no se expande en línea (lleva subconsultas) y se llamaría por
 * fila, con el ARRAY(…) de las anclas uno-a-muchos calculado para nada.
 */
function scopeHas(kind: ScopeKind): string {
  return (
    `EXISTS (SELECT 1 FROM membership_scope s WHERE s.workspace_id = current_workspace_id() ` +
    `AND s.user_id = current_user_id() AND s.scope_type = '${kind}')`
  );
}

function anchorSql(anchor: string | ScopeMany): string {
  return typeof anchor === 'string' ? anchor : `ARRAY(${anchor.any})`;
}

/**
 * El predicado de alcance de una tabla raíz, para componer en un WHERE:
 *
 *   const SCOPE_CAMPAIGN = scopeFilter({ creator: 'c.creator_id', company: 'c.company_id', campaign: 'c.id' });
 *   `SELECT … FROM campaign c WHERE c.id = $1 AND ${SCOPE_CAMPAIGN}`
 *
 * Por cada tipo: `(NOT <tengo alcance de ese tipo> OR scope_allows('<tipo>',
 * <ancla>))`, o `NOT <tengo alcance de ese tipo>` cuando el ancla es null.
 * No lleva parámetros: las anclas son expresiones sobre los alias de la
 * propia consulta, nunca valores que lleguen de fuera.
 */
export function scopeFilter(anchors: ScopeAnchors): string {
  return SCOPE_KINDS.map((kind) => {
    const anchor = anchors[kind];
    if (anchor === null) return `NOT ${scopeHas(kind)}`;
    return `(NOT ${scopeHas(kind)} OR scope_allows('${kind}', ${anchorSql(anchor)}))`;
  }).join(' AND ');
}

/**
 * El predicado de lo que es del ESPACIO ENTERO y no cuelga de ningún
 * creador, marca ni campaña (un gasto, la configuración financiera):
 * solo lo ve quien no tiene ninguna fila de alcance. Es `scopeFilter()`
 * con las tres anclas en `null`, con nombre para que se lea como una
 * decisión y no como un olvido.
 */
export const UNSCOPED_ONLY: string = scopeFilter({ creator: null, company: null, campaign: null });

/** Lo que se iba a escribir quedaría fuera del alcance de quien escribe. */
export class ScopeError extends Error {
  readonly messageEs: string;
  constructor() {
    const messageEs = 'Eso quedaría fuera de tu alcance en este espacio.';
    super(messageEs);
    this.name = 'ScopeError';
    this.messageEs = messageEs;
  }
}

/**
 * Antes de una alta: la fila que se va a crear tiene que caer en el
 * alcance de quien la crea, o nunca podría leerla. Es el mismo principio
 * que 0025 §3 en la base (una fila no puede nombrar otra que su
 * transacción no ve), llevado al alcance. Los insumos que ya son filas
 * (la cotización, el creador, la empresa) se comprueban antes con su
 * consulta filtrada y su `…NotFound`; aquí quedan los valores que la
 * fila nueva va a llevar, NULL incluido («sin campaña» bajo alcance por
 * creador no cae en ningún alcance).
 */
export async function assertScopeAllows(tx: WorkspaceTx, targets: Readonly<Record<ScopeKind, string | null>>): Promise<void> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT scope_allows('creator', $1::uuid) AND scope_allows('company', $2::uuid) AND scope_allows('campaign', $3::uuid) AS ok`,
    [targets.creator, targets.company, targets.campaign],
  );
  if (rows[0]?.ok !== true) throw new ScopeError();
}

/**
 * Antes de escribir algo del espacio entero (un gasto, la configuración
 * financiera): quien tiene alcance —«solo lo de Camilo»— no lo toca,
 * porque lo que cambia es de todos. Lanza `ScopeError` antes de escribir.
 */
export async function assertUnscoped(tx: WorkspaceTx): Promise<void> {
  const { rows } = await tx.query<{ ok: boolean }>(`SELECT ${UNSCOPED_ONLY} AS ok`);
  if (rows[0]?.ok !== true) throw new ScopeError();
}

/**
 * Los tipos de alcance que tiene la persona de la transacción en el
 * workspace fijado (vacío = sin alcance: ve todo). Es para que una
 * pantalla EXPLIQUE una ausencia —«los gastos son de todo el espacio y
 * no están en tu alcance»— en vez de pintar un vacío mudo; el filtro lo
 * siguen poniendo las consultas.
 */
export async function getScopeKinds(tx: WorkspaceTx): Promise<ScopeKind[]> {
  const { rows } = await tx.query<{ scope_type: ScopeKind }>(
    `SELECT DISTINCT s.scope_type FROM membership_scope s
      WHERE s.workspace_id = current_workspace_id() AND s.user_id = current_user_id()
      ORDER BY 1`,
  );
  return rows.map((r) => r.scope_type);
}
