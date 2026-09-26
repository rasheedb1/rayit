/**
 * El brief de outbound (VEN-7): qué busca el creador y qué no acepta,
 * sobre `outbound_brief`. Dueño: Rasheed.
 *
 * Dos usos, y los dos salen de aquí:
 *
 *   1. La pantalla /ventas/brief lo lee y lo guarda (getBrief, saveBrief,
 *      las opciones de categorías y de empresas).
 *   2. El radar lo APLICA: una señal de una categoría o de una empresa
 *      que el brief activo excluye no aparece en la bandeja, y la
 *      bandeja dice cuántas quedaron fuera («3 señales ocultas por tu
 *      brief»). La regla es UNA expresión SQL, briefVerdictSql, y la
 *      usan listSignals, countPendingSignals, getSalesKpis y la ficha de
 *      la empresa (queries/ventas.ts) y countHiddenSignals de aquí: el
 *      número del KPI, el de la pestaña, las tarjetas y la ficha no pueden
 *      decir cosas distintas.
 *   3. Las cadencias lo RESPETAN: enrollContacts no inscribe y el
 *      despachador cancela lo de una marca excluida (briefCompanyVerdictSql).
 *
 * Un brief es de UN creador, con uno activo por creador (0064 §1), y la
 * pantalla edita el de un creador concreto (getBrief y saveBrief reciben
 * su id). Con varios creadores en el espacio:
 *   · las cadencias usan el del creador del negocio y, si ese creador no
 *     tiene brief activo, lo que excluyen todos los activos del espacio;
 *   · el radar, que es del espacio (una señal no tiene creador), oculta
 *     solo lo que excluyen todos.
 *
 * Qué es la «categoría» de una señal. El brief habla en categorías de
 * marca —«alimentos», «alcohol», «apuestas»— y una señal no tiene
 * columna de categoría: la tiene su empresa (company.industry y
 * company.niche_slugs) y, en las que todavía no tienen empresa (las
 * manuales y las de CSV), lo que se escribió al anotarla
 * (evidence.industry). Las fuentes automáticas dejan además
 * evidence.category («snacks» en Meta) o evidence.brief_category (el
 * marketplace de TikTok). Todas cuentan, y se comparan con brand_key
 * (0031): sin tildes, sin mayúsculas, sin signos. «Suplementos» excluye
 * «SUPLEMENTOS» y «suplementos ».
 *
 * «Qué busca» (categorías, países, presupuesto) NO oculta nada: la
 * bandeja MARCA en cada tarjeta lo que la aparta del brief («Bajo tu
 * mínimo», «Fuera de tus países», «Fuera de lo que buscas»;
 * briefSignalLateralSql). Ocultar por «no encaja del todo» escondería
 * señales que valen la pena; ocultar por «esto no lo acepto» es
 * exactamente lo que el creador pidió. Del brief, el recomendador y el
 * generador usan además el título, las notas, la divulgación, los
 * formatos que ofrece y su ventana de disponibilidad (docs/ventas-outreach.md
 * §5.5 y §5.8): el pitch solo propone esos formatos y fechas dentro de
 * la ventana.
 *
 * Mismas reglas que el resto de queries/: WorkspaceTx, RLS filtra, los
 * INSERT escriben current_workspace_id(), el dinero viaja como string.
 */
import { categoryKey } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../client.ts';
import type { BRIEF_STATUSES } from '../schema/ventas.ts';

export type BriefStatus = (typeof BRIEF_STATUSES)[number];

/** Topes de las listas: los mismos CHECK de 0064 (outbound_brief_list_sizes). */
export const BRIEF_LIMITS = {
  categories: 30,
  countries: 30,
  companies: 100,
  titleMax: 120,
  categoryMax: 60,
  notesMax: 2000,
  /** Formatos de entregable distintos: el catálogo tiene seis (DELIVERABLES de @mc/core); el tope deja sitio a los viejos. */
  deliverables: 20,
  /** El nombre de una marca que se da de alta desde el brief (rejectBrandByName, VEN-7 r5). */
  brandNameMax: 120,
} as const;

/**
 * Las formas que la base acepta (VEN-7 r5): una fecha de la ventana
 * (AAAA-MM-DD) y el tipo de un entregable. La Server Action del brief las
 * importa de aquí: si una cambia, la acción y la consulta no pueden
 * dejar de coincidir.
 */
export const BRIEF_PATTERNS = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  deliverable: /^[a-z_]{1,40}$/,
} as const;

/** Por qué una señal no aparece en la bandeja: la empresa o la categoría están excluidas. */
export type BriefVerdict = 'company' | 'category';

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export const BRIEF_ERROR_CODES = [
  'InvalidTitle',
  'InvalidCategory',
  'TooManyCategories',
  'CategoryConflict',
  'InvalidCountry',
  'TooManyCountries',
  'InvalidBudget',
  'InvalidCurrency',
  'InvalidWindow',
  'InvalidDeliverable',
  'InvalidNotes',
  'CompanyNotInCrm',
  'TooManyCompanies',
  'NoCreator',
  'UnknownCreator',
  'NoActiveBrief',
  'SignalNotFound',
  'SignalWithoutBrand',
  'InvalidBrandName',
  'Forbidden',
] as const;
export type BriefErrorCode = (typeof BRIEF_ERROR_CODES)[number];

/**
 * Un error de dominio del brief. Como VentasError: lleva el CÓDIGO y,
 * si hace falta, el dato para componer la frase (la categoría que está
 * en las dos listas). La frase la pone la pantalla con su messages.ts.
 */
export class BriefError extends Error {
  readonly code: BriefErrorCode;
  readonly detail: string | null;
  constructor(code: BriefErrorCode, detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BriefError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

/** Un entregable del brief, como se guarda en `deliverables` (jsonb). */
export interface BriefDeliverable {
  kind: string;
  /** El seed guarda la etiqueta y el rango del tarifario; la pantalla usa la suya por `kind`. */
  label?: string;
  price_low?: number | string;
  price_high?: number | string;
}

export interface OutboundBrief {
  id: string;
  creatorId: string;
  creatorName: string;
  title: string;
  wantedCategories: string[];
  wantedCountries: string[];
  /** Decimal como string; null si no hay mínimo. */
  minBudget: string | null;
  currency: string;
  /** Los tipos de entregable (`kind`), en el orden guardado. */
  deliverables: string[];
  availabilityFrom: string | null;
  availabilityTo: string | null;
  excludedCategories: string[];
  /** Las empresas excluidas que este workspace puede ver, con su nombre. */
  excludedCompanies: { id: string; name: string }[];
  requiresDisclosure: boolean;
  notes: string | null;
  status: BriefStatus;
  updatedAt: string;
}

/**
 * Formatos que en datos viejos tienen otro nombre: el seed 0002 escribió
 * «historias» y el catálogo (DELIVERABLES de @mc/core, rate_card_item)
 * dice «historia». Se leen con el nombre del catálogo, para que la
 * pantalla no enseñe dos casillas de lo mismo, y al guardar se conserva
 * lo que traían (la etiqueta y el rango del tarifario).
 */
const DELIVERABLE_ALIASES: Readonly<Record<string, string>> = { historias: 'historia' };

function canonicalKind(kind: string): string {
  return DELIVERABLE_ALIASES[kind] ?? kind;
}

/**
 * Los tipos de entregable de outbound_brief.deliverables (jsonb), con el
 * nombre del catálogo, sin repetir y en el orden guardado. Lo usan la
 * pantalla (toBrief) y el contexto de las cadencias (el recomendador y
 * el generador), para que los tres lean lo mismo.
 */
export function briefDeliverableKinds(raw: unknown): string[] {
  const lista = Array.isArray(raw) ? (raw as BriefDeliverable[]) : [];
  return [
    ...new Set(
      lista
        .map((d) => (d && typeof d.kind === 'string' ? canonicalKind(d.kind) : null))
        .filter((k): k is string => k !== null),
    ),
  ];
}

type BriefRowSql = {
  id: string; creator_id: string; creator_name: string; title: string;
  wanted_categories: string[]; wanted_countries: string[]; min_budget: string | null; currency: string;
  deliverables: BriefDeliverable[]; availability_from: string | null; availability_to: string | null;
  excluded_categories: string[]; excluded_companies: { id: string; name: string }[] | null;
  requires_disclosure: boolean; notes: string | null; status: BriefStatus; updated_at: Date | string;
};

const BRIEF_SELECT = `
  SELECT b.id, b.creator_id, cp.display_name AS creator_name, b.title,
         b.wanted_categories, b.wanted_countries, b.min_budget::text AS min_budget, b.currency::text AS currency,
         b.deliverables, b.availability_from::text AS availability_from, b.availability_to::text AS availability_to,
         b.excluded_categories,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', co.id, 'name', co.name) ORDER BY co.name), '[]'::jsonb)
            FROM company co
           WHERE co.id = ANY (b.excluded_companies)) AS excluded_companies,
         b.requires_disclosure, b.notes, b.status, b.updated_at
    FROM outbound_brief b
    JOIN creator_profile cp ON cp.id = b.creator_id`;

function toBrief(r: BriefRowSql): OutboundBrief {
  return {
    id: r.id,
    creatorId: r.creator_id,
    creatorName: r.creator_name,
    title: r.title,
    wantedCategories: r.wanted_categories,
    wantedCountries: r.wanted_countries,
    minBudget: r.min_budget,
    currency: r.currency,
    deliverables: briefDeliverableKinds(r.deliverables),
    availabilityFrom: r.availability_from,
    availabilityTo: r.availability_to,
    excludedCategories: r.excluded_categories,
    excludedCompanies: r.excluded_companies ?? [],
    requiresDisclosure: r.requires_disclosure,
    notes: r.notes,
    status: r.status,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

/** El orden en que se elige «el brief de un creador»: el activo y, si no hay, el último que se tocó. */
const BRIEF_ORDER = `ORDER BY (b.status = 'active') DESC, b.updated_at DESC, b.created_at DESC, b.id`;

/** El brief activo de un creador, o null (en pausa, o sin brief). */
export async function getActiveBrief(tx: WorkspaceTx, creatorId: string): Promise<OutboundBrief | null> {
  if (!isUuid(creatorId)) return null;
  const { rows } = await tx.query<BriefRowSql>(
    `${BRIEF_SELECT} WHERE b.status = 'active' AND b.creator_id = $1::uuid ${BRIEF_ORDER} LIMIT 1`,
    [creatorId],
  );
  return rows[0] ? toBrief(rows[0]) : null;
}

/**
 * El brief que la pantalla edita para un creador: el activo o, si no
 * hay, el último que se tocó (uno en pausa se sigue pudiendo editar y
 * reactivar). Null si ese creador nunca tuvo uno, o si no es de este
 * workspace (RLS no deja ver el de otro).
 *
 * Un brief es de UN creador (outbound_brief.creator_id, uno activo por
 * creador, 0064 §1): el recomendador y el generador leen el del creador
 * del negocio. Por eso la pantalla elige creador y no hay «el brief del
 * espacio»: con dos creadores, editar «el último tocado» sobrescribía el
 * de otro sin saberlo.
 */
export async function getBrief(tx: WorkspaceTx, creatorId: string): Promise<OutboundBrief | null> {
  if (!isUuid(creatorId)) return null;
  const { rows } = await tx.query<BriefRowSql>(`${BRIEF_SELECT} WHERE b.creator_id = $1::uuid ${BRIEF_ORDER} LIMIT 1`, [
    creatorId,
  ]);
  return rows[0] ? toBrief(rows[0]) : null;
}

/** Un creador del espacio, con el estado de su brief (el que editaría la pantalla). */
export interface BriefCreator {
  id: string;
  displayName: string;
  /** Null si todavía no tiene brief. */
  briefStatus: BriefStatus | null;
  briefTitle: string | null;
}

/**
 * Los creadores a los que se les puede escribir brief, en el orden en
 * que se crearon (el primero es el principal, como en Cotizar), y el
 * tipo de espacio. Un creador borrado no sale; uno inactivo sale solo si
 * ya tiene brief, para no perderlo de vista.
 *
 * La pantalla elige con esto de quién es el brief que enseña
 * (pickBriefCreator) y, si hay más de un brief activo, lo dice: el radar
 * oculta solo lo que excluyen todos.
 */
export async function listBriefCreators(
  tx: WorkspaceTx,
): Promise<{ workspaceKind: 'creator' | 'agency'; creators: BriefCreator[] }> {
  const { rows: ws } = await tx.query<{ kind: string }>('SELECT kind FROM workspace WHERE id = current_workspace_id()');
  const { rows } = await tx.query<{ id: string; display_name: string; brief_status: BriefStatus | null; brief_title: string | null }>(
    `SELECT cp.id, cp.display_name, ub.status AS brief_status, ub.title AS brief_title
       FROM creator_profile cp
       LEFT JOIN LATERAL (
              SELECT b.status, b.title FROM outbound_brief b WHERE b.creator_id = cp.id ${BRIEF_ORDER} LIMIT 1
            ) ub ON true
      WHERE cp.deleted_at IS NULL AND (cp.status = 'active' OR ub.status IS NOT NULL)
      ORDER BY cp.created_at, cp.id
      LIMIT 200`,
  );
  return {
    workspaceKind: ws[0]?.kind === 'agency' ? 'agency' : 'creator',
    creators: rows.map((r) => ({ id: r.id, displayName: r.display_name, briefStatus: r.brief_status, briefTitle: r.brief_title })),
  };
}

/**
 * De quién es el brief que se enseña: el creador pedido (?creador=id) si
 * es de este espacio; si no, el primero con brief activo; si ninguno lo
 * tiene, el primero (el principal). Null sin creadores.
 */
export function pickBriefCreator(creators: BriefCreator[], requested: string | null | undefined): BriefCreator | null {
  return (
    (requested ? creators.find((c) => c.id === requested) : undefined) ??
    creators.find((c) => c.briefStatus === 'active') ??
    creators[0] ??
    null
  );
}

/**
 * Las categorías que ya aparecen en este workspace, para sugerirlas al
 * escribir: los sectores y nichos de las empresas del CRM, lo que traen
 * las señales y lo que ya tiene el brief. Sin repetir (por brand_key),
 * con la primera grafía que aparezca, en orden alfabético.
 */
export async function listCategorySuggestions(tx: WorkspaceTx): Promise<string[]> {
  const { rows } = await tx.query<{ category: string }>(
    `WITH todas AS (
       SELECT btrim(co.industry) AS category
         FROM company_link cl JOIN company co ON co.id = cl.company_id
       UNION ALL
       SELECT btrim(n) FROM company_link cl JOIN company co ON co.id = cl.company_id, unnest(co.niche_slugs) n
       UNION ALL
       SELECT btrim(s.evidence->>k) FROM signal s, unnest(ARRAY['industry', 'category', 'brief_category']) k
       UNION ALL
       SELECT btrim(c) FROM outbound_brief b, unnest(b.wanted_categories || b.excluded_categories) c
     )
     -- De las grafías de una misma categoría, la que menos grita: en
     -- minúsculas si alguien la escribió así, si no la que no va toda en
     -- mayúsculas («Alcohol» antes que «ALCOHOL»).
     SELECT g.category FROM (
       SELECT (array_agg(category ORDER BY (category = lower(category)) DESC,
                                           (category = upper(category)) ASC,
                                           category))[1] AS category
         FROM todas
        WHERE brand_key(category) IS NOT NULL AND length(category) <= $1
        GROUP BY brand_key(category)
     ) g
     ORDER BY lower(g.category), g.category
     LIMIT 200`,
    [BRIEF_LIMITS.categoryMax],
  );
  return rows.map((r) => r.category);
}

/** Cuántas marcas devuelve como mucho una búsqueda de «Marcas que no aceptas». */
export const BRIEF_COMPANY_SEARCH_LIMIT = 20;
/** Lo mínimo que hay que escribir para buscar (en caracteres de brand_key: sin tildes ni signos). */
export const BRIEF_COMPANY_SEARCH_MIN = 2;

/**
 * Las marcas del CRM que se pueden excluir y cuyo nombre contiene lo
 * escrito, comparado con brand_key («nutrive» encuentra «Nutrivé»): las
 * que EMPIEZAN así primero, luego por nombre. Como mucho
 * BRIEF_COMPANY_SEARCH_LIMIT; con menos de BRIEF_COMPANY_SEARCH_MIN
 * caracteres útiles no busca.
 *
 * Hasta la ronda 3 la pantalla recibía las primeras 1 000 del CRM en un
 * <select> y cortaba el resto sin avisar: una agencia con un CRM grande
 * no podía excluir las que quedaban fuera. Ahora busca en el servidor,
 * en todo el CRM. Las marcas que todavía no están en el CRM se excluyen
 * desde su señal en el radar (rejectSignalBrand) o, sin señal, por su
 * nombre desde el brief (rejectBrandByName, VEN-7 r5): las dos la dan de alta.
 */
export async function searchBriefCompanies(tx: WorkspaceTx, q: string): Promise<{ id: string; name: string }[]> {
  if (categoryKey(q).length < BRIEF_COMPANY_SEARCH_MIN) return [];
  // La clave la calcula la base con brand_key, la misma función que llena
  // company.name_key: lo escrito y lo guardado se normalizan igual.
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT co.id, co.name
       FROM company_link cl
       JOIN company co ON co.id = cl.company_id
       CROSS JOIN (SELECT brand_key($1) AS k) q
      WHERE q.k IS NOT NULL AND strpos(co.name_key, q.k) > 0
      ORDER BY (strpos(co.name_key, q.k) = 1) DESC, lower(co.name), co.id
      LIMIT $2`,
    [q.slice(0, 200), BRIEF_COMPANY_SEARCH_LIMIT],
  );
  return rows;
}

// ---------------------------------------------------------------------
// El radar, la ficha y las cadencias: qué deja fuera el brief activo
// ---------------------------------------------------------------------

/** Un alias o una columna que se compone dentro del SQL: nunca algo que venga de fuera. */
const SQL_REF_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
/** Un parámetro posicional con su tipo, «$1::uuid». */
const SQL_PARAM_RE = /^\$\d+::uuid$/;
/** Los alias de dentro del veredicto empiezan así; el de fuera no puede, o se confundirían. */
const INNER_PREFIX = 'bv_';

function assertRef(fn: string, ref: string, param = false): void {
  if ((SQL_REF_RE.test(ref) && !ref.startsWith(INNER_PREFIX)) || (param && SQL_PARAM_RE.test(ref))) return;
  throw new Error(`${fn}: referencia inválida «${ref}»`);
}

/** Las columnas de la empresa que el veredicto mira, en el orden de bv_emp. */
const EMP_COLS = 'bv_co.id, bv_co.name, bv_co.industry, bv_co.niche_slugs, bv_co.country::text AS country';

/**
 * La empresa de la señal `s`, con la regla de resolveCompany
 * (queries/ventas.ts):
 *
 *   · por id, si la señal ya tiene empresa;
 *   · si no, por dominio, si la señal trae uno (el dominio es único en el
 *     catálogo y dentro de cada dueño: es la misma marca; normalizeDomain
 *     lo guarda en minúsculas y así se busca);
 *   · si tampoco, por nombre (brand_key: «Nutrivé» = «NUTRIVE»), pero
 *     solo entre las empresas del CRM de este workspace (company_link):
 *     fuera del CRM un nombre no basta, dos «Alma» de dos países no son
 *     la misma marca.
 *
 * Son búsquedas SEPARADAS unidas con UNION ALL, cada una con su índice:
 * la llave primaria; el de (domain::text); y company_link, que ya acota
 * al CRM, con el de name_key (brand_key(name) calculada por la base). Los
 * dos últimos son de 0065, y la comparación es text = text a propósito:
 * bajo RLS Postgres solo usa un índice si la condición es leakproof, y ni
 * brand_key(co.name) (regexp_replace) ni citext = citext lo son (0065
 * explica la medición). Hasta la ronda 2 era una sola condición con OR
 * sobre company entera, que ningún índice sirve: con 10 000 empresas en
 * el catálogo y 100 señales, countHiddenSignals tardaba 28,6 s.
 *
 * `EXISTS (SELECT 1 FROM bv_briefs)` se evalúa una vez por consulta: sin
 * brief activo no se busca nada.
 */
function signalCompanyRowsSql(s: string): string {
  const dominio = `lower(nullif(btrim(${s}.evidence->>'domain'), ''))`;
  return `
         SELECT ${EMP_COLS} FROM company bv_co
          WHERE bv_co.id = ${s}.company_id AND EXISTS (SELECT 1 FROM bv_briefs)
         UNION ALL
         SELECT ${EMP_COLS} FROM company bv_co
          WHERE ${s}.company_id IS NULL AND bv_co.domain::text = ${dominio} AND EXISTS (SELECT 1 FROM bv_briefs)
         UNION ALL
         SELECT ${EMP_COLS} FROM company_link bv_l JOIN company bv_co ON bv_co.id = bv_l.company_id
          WHERE ${s}.company_id IS NULL AND ${dominio} IS NULL
            AND bv_co.name_key = brand_key(${s}.evidence->>'company_name') AND EXISTS (SELECT 1 FROM bv_briefs)`;
}

/**
 * La primera categoría de `lista` (una columna text[] del brief) que está
 * entre las de la marca (bv_cats), comparadas con brand_key: «Suplementos»
 * excluye «SUPLEMENTOS» y «suplementos ». Devuelve cómo la escribió el
 * creador, para decirle cuál regla la dejó fuera.
 */
function firstCategoryMatchSql(lista: string): string {
  return `(SELECT bv_u.cat FROM unnest(${lista}) WITH ORDINALITY bv_u(cat, i)
            WHERE brand_key(bv_u.cat) IN (SELECT bv_c.k FROM bv_cats bv_c)
            ORDER BY bv_u.i LIMIT 1)`;
}

interface VerdictParts {
  /** Qué briefs activos cuentan (una condición sobre bv_b). */
  briefsWhere: string;
  /** Las filas de la empresa, con EMP_COLS. */
  companyRows: string;
  /** Lo que trae la señal además de su empresa (evidence), o nada. */
  signal: string | null;
  /** Si además calcula el encaje con «Qué buscas» (solo la bandeja lo pinta). */
  fit: boolean;
}

/**
 * La consulta del veredicto: UNA fila con hidden_by ('company',
 * 'category' o NULL), hidden_match (la marca o la categoría que lo
 * decidió) y, con `fit`, wanted_match, below_min_budget,
 * country_outside y category_outside.
 *
 * Los briefs activos se leen UNA vez por consulta (bv_briefs, un CTE
 * MATERIALIZED que no depende de la fila de fuera: Postgres lo rebobina
 * en vez de recalcularlo). La empresa y las categorías de la marca, una
 * vez por señal (bv_emp, bv_cats), y cada brief se compara contra esas
 * dos listas cortas.
 *
 * Varios briefs activos (uno por creador, 0064 §1): la marca queda fuera
 * solo si TODOS la excluyen, porque lo que un creador no acepta otro del
 * mismo espacio puede aceptarlo. El motivo es 'company' si alguno la
 * excluye por nombre. El encaje sigue la misma idea: «Bajo tu mínimo» y
 * «Fuera de tus países» y «Fuera de lo que buscas» solo si lo están para
 * todos, y la categoría buscada basta con que la busque uno.
 */
function verdictQuery({ briefsWhere, companyRows, signal, fit }: VerdictParts): string {
  const deLaSenal = signal
    ? `UNION ALL SELECT ${signal}.evidence->>'industry'
                UNION ALL SELECT ${signal}.evidence->>'category'
                UNION ALL SELECT ${signal}.evidence->>'brief_category'`
    : '';
  const pais = signal
    ? `upper(coalesce(nullif(btrim(${signal}.evidence->>'country'), ''),
                        (SELECT bv_e.country FROM bv_emp bv_e WHERE bv_e.country IS NOT NULL LIMIT 1)))`
    : `(SELECT upper(bv_e.country) FROM bv_emp bv_e WHERE bv_e.country IS NOT NULL LIMIT 1)`;
  const presupuesto = signal
    ? `(${signal}.budget_estimate IS NOT NULL AND bv_b.min_budget IS NOT NULL
                  AND bv_b.currency = ${signal}.budget_currency::text AND ${signal}.budget_estimate < bv_b.min_budget)`
    : 'false';
  const porBriefFit = fit
    ? `,
              ${firstCategoryMatchSql('bv_b.wanted_categories')} AS wanted_match,
              cardinality(bv_b.wanted_categories) > 0 AS has_wanted,
              ${presupuesto} AS below_min,
              (bv_p.country IS NOT NULL AND cardinality(bv_b.wanted_countries) > 0
                AND NOT (bv_p.country = ANY (bv_b.wanted_countries))) AS outside`
    : '';
  const oculta = `count(*) > 0 AND bool_and(bv_pb.company_match IS NOT NULL OR bv_pb.category_match IS NOT NULL)`;
  const finalFit = fit
    ? `,
            min(bv_pb.wanted_match) AS wanted_match,
            coalesce(count(*) > 0 AND bool_and(bv_pb.below_min), false) AS below_min_budget,
            coalesce(count(*) > 0 AND bool_and(bv_pb.outside), false) AS country_outside,
            coalesce(count(*) > 0 AND bool_and(bv_pb.has_wanted AND bv_pb.wanted_match IS NULL), false) AS category_outside`
    : '';
  return `WITH bv_briefs AS MATERIALIZED (
         SELECT bv_b.excluded_companies, bv_b.excluded_categories, bv_b.wanted_categories, bv_b.wanted_countries,
                bv_b.min_budget, bv_b.currency::text AS currency
           FROM outbound_brief bv_b
          WHERE bv_b.status = 'active' AND ${briefsWhere}
       ),
       bv_emp AS (${companyRows}
       ),
       bv_cats AS (
         SELECT DISTINCT brand_key(bv_x.cat) AS k
           FROM (SELECT bv_e.industry FROM bv_emp bv_e
                 UNION ALL SELECT unnest(bv_e.niche_slugs) FROM bv_emp bv_e
                 ${deLaSenal}) bv_x(cat)
          WHERE brand_key(bv_x.cat) IS NOT NULL
       ),
       bv_pb AS (
         SELECT (SELECT bv_e.name FROM bv_emp bv_e WHERE bv_e.id = ANY (bv_b.excluded_companies)
                  ORDER BY bv_e.name LIMIT 1) AS company_match,
                ${firstCategoryMatchSql('bv_b.excluded_categories')} AS category_match${porBriefFit}
           FROM bv_briefs bv_b${fit ? `, (SELECT ${pais} AS country) bv_p` : ''}
       )
       SELECT CASE WHEN ${oculta}
                   THEN CASE WHEN bool_or(bv_pb.company_match IS NOT NULL) THEN 'company' ELSE 'category' END
              END AS hidden_by,
              CASE WHEN ${oculta}
                   THEN coalesce(min(bv_pb.company_match), min(bv_pb.category_match))
              END AS hidden_match${finalFit}
         FROM bv_pb bv_pb`;
}

/** El veredicto de una señal, como consulta de una fila para un LATERAL. */
function signalVerdictQuery(s: string, fit: boolean): string {
  return verdictQuery({
    briefsWhere: 'bv_b.workspace_id = current_workspace_id()',
    companyRows: signalCompanyRowsSql(s),
    signal: s,
    fit,
  });
}

/**
 * La expresión SQL que dice por qué el brief activo deja fuera una
 * señal: 'company', 'category' o NULL (la señal se ve). `s` es el alias
 * de `signal` en la consulta que la usa; el texto es constante (no lleva
 * nada que venga de fuera), así que se puede componer.
 *
 * Mira solo la fila de la señal (company_id y evidence), igual en la
 * bandeja que en los conteos y en la ficha de la empresa, para que
 * «5 por revisar», las tarjetas y «1 señal en el radar» cuadren siempre:
 *
 *   · Empresa excluida: la de la señal según signalCompanyRowsSql.
 *   · Categoría excluida: el sector y los nichos de esa misma empresa, y
 *     lo que trae la señal en evidence (industry, category,
 *     brief_category).
 *
 * Una señal todavía no es de ningún creador, así que valen todos los
 * briefs activos del espacio. Es para consultas bajo RLS (la web): el
 * espacio es el fijado en la transacción (current_workspace_id()). El
 * worker, que corre sin RLS, usa briefCompanyVerdictSql con el workspace
 * explícito.
 */
export function briefVerdictSql(s: string): string {
  assertRef('briefVerdictSql', s);
  return `(SELECT bv_v.hidden_by FROM (${signalVerdictQuery(s, false)}) bv_v)`;
}

/**
 * Lo mismo que briefVerdictSql, más lo que la bandeja pinta en la
 * tarjeta, como una consulta de UNA fila para un CROSS JOIN LATERAL:
 *
 *   hidden_by         'company' | 'category' | NULL
 *   hidden_match      la marca o la categoría excluida que lo decidió
 *                     («harinas», «Molino Andino»), para decir cuál regla
 *   wanted_match      la primera categoría buscada que tiene la marca
 *   below_min_budget  el presupuesto estimado está por debajo del mínimo
 *                     (misma moneda; con otra moneda no se compara)
 *   country_outside   el país de la señal (evidence.country, o el de su
 *                     empresa) no está entre los buscados
 *   category_outside  el brief busca categorías y la marca no tiene
 *                     ninguna («Fuera de lo que buscas»)
 *
 * El encaje NO oculta nada: «Qué buscas» es una preferencia (VEN-7).
 */
export function briefSignalLateralSql(s: string): string {
  assertRef('briefSignalLateralSql', s);
  return signalVerdictQuery(s, true);
}

/**
 * Lo mismo para una EMPRESA ya conocida (la de un toque o la de un
 * contacto que se enrola): 'company' si el brief la excluye por nombre,
 * 'category' si excluye su sector o uno de sus nichos, NULL si no.
 * `companyId`, `workspace` y `deal` son columnas («t.company_id») o
 * parámetros («$2::uuid») de la consulta que la usa.
 *
 * El brief que cuenta es el del creador del negocio (`deal`), como en el
 * recomendador y el generador (VEN-13): la cadencia escribe en su nombre
 * y la pantalla edita el brief de cada creador. Si ese creador no tiene
 * brief activo —o no hay negocio, o el negocio no tiene creador—, los de
 * todos los creadores del espacio, con la misma regla que el radar: en
 * una agencia, un creador sin brief propio no se salta lo que excluyen
 * los demás.
 *
 * Lleva el workspace explícito porque la usa el worker (enrollContacts
 * y el reclamo del despachador), que corre con BYPASSRLS: sin el filtro
 * aplicaría el brief de cualquier otro espacio.
 */
export function briefCompanyVerdictSql(companyId: string, workspace: string, deal = 'NULL::uuid'): string {
  assertRef('briefCompanyVerdictSql', companyId, true);
  assertRef('briefCompanyVerdictSql', workspace, true);
  if (deal !== 'NULL::uuid') assertRef('briefCompanyVerdictSql', deal, true);
  const creador = `(SELECT bv_d.creator_id FROM deal bv_d WHERE bv_d.id = ${deal})`;
  const query = verdictQuery({
    briefsWhere: `bv_b.workspace_id = ${workspace}
            AND (bv_b.creator_id = ${creador}
                 OR NOT EXISTS (SELECT 1 FROM outbound_brief bv_o
                                 WHERE bv_o.status = 'active' AND bv_o.workspace_id = ${workspace}
                                   AND bv_o.creator_id = ${creador}))`,
    companyRows: `
         SELECT ${EMP_COLS} FROM company bv_co WHERE bv_co.id = ${companyId}`,
    signal: null,
    fit: false,
  });
  return `(SELECT bv_v.hidden_by FROM (${query}) bv_v)`;
}

/** Cuántas señales PENDIENTES deja fuera el brief activo, y por qué. */
export interface HiddenSignals {
  total: number;
  byCompany: number;
  byCategory: number;
}

/**
 * La consulta de countHiddenSignals, exportada para que las pruebas lean
 * su plan (EXPLAIN) como mc_app: el veredicto tiene que llegar a la
 * empresa por sus índices (company_name_key_idx, company_domain_text_idx,
 * la llave primaria) y nunca recorrer company entera.
 */
export const HIDDEN_SIGNALS_SQL = `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE v.verdict = 'company')::text  AS by_company,
            count(*) FILTER (WHERE v.verdict = 'category')::text AS by_category
       FROM signal s
      CROSS JOIN LATERAL (SELECT ${briefVerdictSql('s')} AS verdict) v
      WHERE s.status = 'pending' AND v.verdict IS NOT NULL`;

/** Lo que la bandeja dice debajo del título: «3 señales ocultas por tu brief». */
export async function countHiddenSignals(tx: WorkspaceTx): Promise<HiddenSignals> {
  const { rows } = await tx.query<{ total: string; by_company: string; by_category: string }>(HIDDEN_SIGNALS_SQL);
  const r = rows[0];
  return { total: Number(r?.total ?? 0), byCompany: Number(r?.by_company ?? 0), byCategory: Number(r?.by_category ?? 0) };
}

// ---------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------

export interface SaveBriefInput {
  title: string;
  wantedCategories: string[];
  wantedCountries: string[];
  /** Decimal como string («3000000.00»); null sin mínimo. */
  minBudget: string | null;
  /** La moneda del mínimo (ISO-4217). La pantalla manda la del brief o la del workspace. */
  currency: string;
  /** Tipos de entregable (`kind`): 'reel', 'tiktok'… */
  deliverables: string[];
  availabilityFrom: string | null;
  availabilityTo: string | null;
  excludedCategories: string[];
  excludedCompanyIds: string[];
  requiresDisclosure: boolean;
  notes: string | null;
  /** Activo: el radar lo aplica. Si no, queda en pausa y no oculta nada. */
  active: boolean;
}

/** Recorta, colapsa espacios, descarta vacías y repetidas (por categoryKey), y valida el largo y el tope. */
function cleanCategories(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const cat = raw.trim().replace(/\s+/g, ' ');
    const key = categoryKey(cat);
    if (!key) continue;
    if (cat.length > BRIEF_LIMITS.categoryMax) throw new BriefError('InvalidCategory', cat);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cat);
  }
  if (out.length > BRIEF_LIMITS.categories) throw new BriefError('TooManyCategories');
  return out;
}

const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const DATE_RE = BRIEF_PATTERNS.date;
const DELIVERABLE_RE = BRIEF_PATTERNS.deliverable;

function validDate(v: string | null): boolean {
  if (v === null) return true;
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Guarda el brief de un creador del workspace: actualiza el que devuelve
 * getBrief(tx, creatorId) o, si ese creador no tiene ninguno, lo crea.
 * Devuelve su id. Un creador que no es de este workspace (RLS no lo deja
 * ver) o que está borrado es UnknownCreator: nunca se escribe el brief
 * de otro creador que el pedido.
 *
 * Valida aquí lo mismo que los CHECK de 0064 y algo más que la base no
 * puede saber: que una categoría no esté a la vez en «busco» y en «no
 * acepto» (CategoryConflict), y que las empresas excluidas sean del CRM
 * de este workspace (CompanyNotInCrm): un uuid ajeno no oculta nada,
 * pero tampoco se guarda.
 *
 * Los entregables conservan lo que ya tenían (la etiqueta y el rango que
 * trae el seed desde el tarifario) si siguen elegidos.
 *
 * Es el brief de un creador: lo que excluye se oculta del radar de todo
 * el equipo cuando lo excluyen todos los briefs activos, y frena las
 * cadencias de sus negocios. Así que:
 *   · solo lo escriben owner y admin: lo mira la acción y lo impone la
 *     base (0064 §5); aquí vuelve como BriefError('Forbidden');
 *   · deja traza en audit_log ('ventas.brief.guardar', antes y después)
 *     en la misma transacción;
 *   · dos guardados a la vez se ordenan con un candado por workspace y
 *     creador (el mismo que toma rejectSignalBrand).
 */
export async function saveBrief(tx: WorkspaceTx, creatorId: string, input: SaveBriefInput): Promise<string> {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (!title || title.length > BRIEF_LIMITS.titleMax) throw new BriefError('InvalidTitle');

  const wanted = cleanCategories(input.wantedCategories);
  const excluded = cleanCategories(input.excludedCategories);
  const excludedKeys = new Set(excluded.map(categoryKey));
  const conflict = wanted.find((c) => excludedKeys.has(categoryKey(c)));
  if (conflict) throw new BriefError('CategoryConflict', conflict);

  const countries = [...new Set(input.wantedCountries.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const badCountry = countries.find((c) => !COUNTRY_RE.test(c));
  if (badCountry) throw new BriefError('InvalidCountry', badCountry);
  if (countries.length > BRIEF_LIMITS.countries) throw new BriefError('TooManyCountries');

  const minBudget = input.minBudget?.trim() || null;
  if (minBudget !== null && !MONEY_RE.test(minBudget)) throw new BriefError('InvalidBudget');
  const currency = input.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) throw new BriefError('InvalidCurrency');

  const from = input.availabilityFrom?.trim() || null;
  const to = input.availabilityTo?.trim() || null;
  if (!validDate(from) || !validDate(to) || (from !== null && to !== null && to < from)) {
    throw new BriefError('InvalidWindow');
  }

  const kinds = [...new Set(input.deliverables.map((d) => d.trim()).filter(Boolean))];
  if (kinds.some((k) => !DELIVERABLE_RE.test(k)) || kinds.length > BRIEF_LIMITS.deliverables) {
    throw new BriefError('InvalidDeliverable');
  }

  const notes = input.notes?.trim() || null;
  if (notes !== null && notes.length > BRIEF_LIMITS.notesMax) throw new BriefError('InvalidNotes');

  const companyIds = [...new Set(input.excludedCompanyIds.map((id) => id.trim()).filter(Boolean))];
  if (companyIds.length > BRIEF_LIMITS.companies) throw new BriefError('TooManyCompanies');
  if (companyIds.some((id) => !isUuid(id))) throw new BriefError('CompanyNotInCrm');
  if (companyIds.length > 0) {
    const { rows } = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM company_link WHERE company_id = ANY ($1::uuid[])',
      [companyIds],
    );
    if (Number(rows[0]?.n ?? 0) !== companyIds.length) throw new BriefError('CompanyNotInCrm');
  }

  if (!isUuid(creatorId)) throw new BriefError('UnknownCreator');
  const { rows: creador } = await tx.query<{ id: string }>(
    'SELECT id FROM creator_profile WHERE id = $1::uuid AND deleted_at IS NULL',
    [creatorId],
  );
  if (!creador[0]) throw new BriefError('UnknownCreator');

  // Un guardado a la vez por creador. El índice único de 0064 solo cubre
  // los ACTIVOS: sin brief todavía, dos guardados «en pausa» a la vez
  // leían los dos «no hay ninguno» y creaban dos. El candado es de la
  // transacción y lleva el workspace y el creador: no frena a nadie más.
  await lockCreatorBrief(tx, creatorId);

  const { rows: actual } = await tx.query<{ id: string; deliverables: BriefDeliverable[]; snapshot: Record<string, unknown> }>(
    `SELECT b.id, b.deliverables, ${AUDIT_SNAPSHOT} AS snapshot
       FROM outbound_brief b
      WHERE b.creator_id = $1::uuid
      ${BRIEF_ORDER}
      LIMIT 1
        FOR UPDATE`,
    [creatorId],
  );
  const previos = new Map(
    (Array.isArray(actual[0]?.deliverables) ? actual[0].deliverables : [])
      .filter((d) => d && typeof d.kind === 'string')
      .map((d) => [canonicalKind(d.kind), d] as const),
  );
  const deliverables = kinds.map((kind) => {
    const previo = previos.get(canonicalKind(kind));
    return previo ? { ...previo, kind: canonicalKind(kind) } : { kind: canonicalKind(kind) };
  });
  const status: BriefStatus = input.active ? 'active' : 'paused';

  const valores = [
    title, wanted, countries, minBudget, currency, JSON.stringify(deliverables), from, to,
    excluded, companyIds, input.requiresDisclosure, notes, status,
  ];

  try {
    let saved: { id: string; snapshot: Record<string, unknown> };
    if (actual[0]) {
      const { rows } = await tx.query<{ id: string; snapshot: Record<string, unknown> }>(
        `UPDATE outbound_brief b
            SET title = $2, wanted_categories = $3, wanted_countries = $4, min_budget = $5::numeric,
                currency = $6, deliverables = $7::jsonb, availability_from = $8::date, availability_to = $9::date,
                excluded_categories = $10, excluded_companies = $11::uuid[], requires_disclosure = $12,
                notes = $13, status = $14
          WHERE b.id = $1
          RETURNING b.id, ${AUDIT_SNAPSHOT} AS snapshot`,
        [actual[0].id, ...valores],
      );
      saved = rows[0]!;
    } else {
      const { rows } = await tx.query<{ id: string; snapshot: Record<string, unknown> }>(
        `INSERT INTO outbound_brief AS b (workspace_id, creator_id, title, wanted_categories, wanted_countries, min_budget,
                                          currency, deliverables, availability_from, availability_to, excluded_categories,
                                          excluded_companies, requires_disclosure, notes, status)
         VALUES (current_workspace_id(), $1, $2, $3, $4, $5::numeric, $6, $7::jsonb, $8::date, $9::date, $10,
                 $11::uuid[], $12, $13, $14)
         RETURNING b.id, ${AUDIT_SNAPSHOT} AS snapshot`,
        [creador[0].id, ...valores],
      );
      saved = rows[0]!;
    }

    // La traza: quién cambió la regla que oculta señales a todo el
    // equipo, y de qué a qué. En la misma transacción: sin traza no hay
    // cambio.
    await tx.query(
      `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
       VALUES (current_workspace_id(), current_user_id(), 'user', 'ventas.brief.guardar', 'outbound_brief', $1::uuid,
               $2::jsonb, $3::jsonb)`,
      [saved.id, actual[0] ? JSON.stringify(actual[0].snapshot) : null, JSON.stringify(saved.snapshot)],
    );
    return saved.id;
  } catch (err) {
    // Las políticas RESTRICTIVE de 0064 §5: solo owner o admin escriben
    // el brief. La acción ya lo mira antes; esto es por si no.
    if (isBriefForbidden(err)) throw new BriefError('Forbidden');
    throw err;
  }
}

/** El candado de la transacción que ordena las escrituras del brief de un creador (saveBrief y addExcludedCompany). */
async function lockCreatorBrief(tx: WorkspaceTx, creatorId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('outbound_brief:' || current_workspace_id()::text || ':' || $1))", [
    creatorId,
  ]);
}

/** Lo que cambió al excluir una marca en los briefs activos. */
export interface AddExcludedCompanyResult {
  /** Los briefs activos a los que se agregó (los que ya la excluían no cuentan). */
  added: number;
  /** Los briefs activos que se miraron: los de los creadores pedidos, o todos. */
  briefs: number;
}

/**
 * Agrega una empresa del CRM a «Marcas que no aceptas» de los briefs
 * ACTIVOS de los creadores pedidos (todos los activos si no se pide
 * ninguno), en la transacción de quien llama. Es la mitad del brief de
 * «No aceptar esta marca» en el radar (rejectSignalBrand, queries/ventas.ts),
 * que antes da de alta la marca en el CRM.
 *
 * Mismas reglas que saveBrief: la empresa tiene que estar en el CRM
 * (CompanyNotInCrm), el tope de marcas es BRIEF_LIMITS.companies
 * (TooManyCompanies), solo owner y admin escriben (Forbidden, 0064 §5),
 * el mismo candado por workspace y creador, y la misma traza en
 * audit_log ('ventas.brief.excluir_marca', antes y después). Sin ningún
 * brief activo que la pueda recibir: NoActiveBrief.
 */
export async function addExcludedCompany(
  tx: WorkspaceTx,
  companyId: string,
  opts: { creatorIds?: readonly string[] } = {},
): Promise<AddExcludedCompanyResult> {
  if (!isUuid(companyId)) throw new BriefError('CompanyNotInCrm');
  const creatorIds = opts.creatorIds ? [...new Set(opts.creatorIds)] : null;
  if (creatorIds && (creatorIds.length === 0 || creatorIds.some((id) => !isUuid(id)))) throw new BriefError('UnknownCreator');

  const { rows: enCrm } = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1::uuid', [companyId]);
  if (enCrm.length === 0) throw new BriefError('CompanyNotInCrm');

  const { rows: activos } = await tx.query<{ creator_id: string }>(
    `SELECT DISTINCT b.creator_id FROM outbound_brief b
      WHERE b.status = 'active' AND ($1::uuid[] IS NULL OR b.creator_id = ANY ($1::uuid[]))
      ORDER BY b.creator_id`,
    [creatorIds],
  );
  if (activos.length === 0) throw new BriefError('NoActiveBrief');

  let added = 0;
  try {
    // En orden de creador: dos exclusiones a la vez toman los candados en
    // el mismo orden y no se esperan en círculo.
    for (const { creator_id } of activos) {
      await lockCreatorBrief(tx, creator_id);
      const { rows: antes } = await tx.query<{ id: string; n: number; tiene: boolean; snapshot: Record<string, unknown> }>(
        `SELECT b.id, cardinality(b.excluded_companies) AS n, $2::uuid = ANY (b.excluded_companies) AS tiene,
                ${AUDIT_SNAPSHOT} AS snapshot
           FROM outbound_brief b
          WHERE b.status = 'active' AND b.creator_id = $1::uuid
          ORDER BY b.updated_at DESC, b.id
          LIMIT 1
            FOR UPDATE`,
        [creator_id, companyId],
      );
      const b = antes[0];
      if (!b || b.tiene) continue;
      if (b.n >= BRIEF_LIMITS.companies) throw new BriefError('TooManyCompanies');
      const { rows: despues } = await tx.query<{ snapshot: Record<string, unknown> }>(
        `UPDATE outbound_brief b SET excluded_companies = array_append(b.excluded_companies, $2::uuid)
          WHERE b.id = $1::uuid
          RETURNING ${AUDIT_SNAPSHOT} AS snapshot`,
        [b.id, companyId],
      );
      await tx.query(
        `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
         VALUES (current_workspace_id(), current_user_id(), 'user', 'ventas.brief.excluir_marca', 'outbound_brief', $1::uuid,
                 $2::jsonb, $3::jsonb)`,
        [b.id, JSON.stringify(b.snapshot), JSON.stringify(despues[0]?.snapshot ?? null)],
      );
      added++;
    }
  } catch (err) {
    if (isBriefForbidden(err)) throw new BriefError('Forbidden');
    throw err;
  }
  return { added, briefs: activos.length };
}

/**
 * Lo que la traza guarda del brief, antes y después: la regla entera,
 * sin el workspace (ya va en su columna) ni las fechas (created_at y
 * updated_at ya las dice la propia fila de audit_log).
 */
const AUDIT_SNAPSHOT = `(to_jsonb(b) - 'workspace_id' - 'created_at' - 'updated_at')`;

/** Un 42501 de las políticas de outbound_brief (0064 §5): quien guarda no es owner ni admin. */
export function isBriefForbidden(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '42501' && /outbound_brief/.test(e.message ?? '');
}
