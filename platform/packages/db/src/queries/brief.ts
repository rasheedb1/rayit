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
 *      usan listSignals, countPendingSignals y getSalesKpis de
 *      queries/ventas.ts y countHiddenSignals de aquí: el número del KPI,
 *      el de la pestaña y las tarjetas no pueden decir cosas distintas.
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
 * «Qué busca» (categorías, países, presupuesto, entregables,
 * disponibilidad) NO oculta nada: es lo que usarán el recomendador y el
 * generador de pitch (docs/ventas-outreach.md §5.5). Ocultar por
 * «no encaja del todo» escondería señales que valen la pena; ocultar
 * por «esto no lo acepto» es exactamente lo que el creador pidió.
 *
 * Mismas reglas que el resto de queries/: WorkspaceTx, RLS filtra, los
 * INSERT escriben current_workspace_id(), el dinero viaja como string.
 */
import { isUuid, type WorkspaceTx } from '../client.ts';
import type { BRIEF_STATUSES } from '../schema/ventas.ts';

export type BriefStatus = (typeof BRIEF_STATUSES)[number];

/** Topes de las listas: los mismos CHECK de 0043 (outbound_brief_list_sizes). */
export const BRIEF_LIMITS = {
  categories: 30,
  countries: 30,
  companies: 100,
  titleMax: 120,
  categoryMax: 60,
  notesMax: 2000,
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
  'InvalidWindow',
  'InvalidDeliverable',
  'InvalidNotes',
  'CompanyNotInCrm',
  'TooManyCompanies',
  'NoCreator',
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
    deliverables: (Array.isArray(r.deliverables) ? r.deliverables : [])
      .map((d) => (d && typeof d.kind === 'string' ? d.kind : null))
      .filter((k): k is string => k !== null),
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

/** El brief activo del workspace, o null. Es el que aplica el radar. */
export async function getActiveBrief(tx: WorkspaceTx): Promise<OutboundBrief | null> {
  const { rows } = await tx.query<BriefRowSql>(`${BRIEF_SELECT} WHERE b.status = 'active' LIMIT 1`);
  return rows[0] ? toBrief(rows[0]) : null;
}

/**
 * El brief que edita la pantalla: el activo o, si no hay, el último que
 * se tocó (uno en pausa se sigue pudiendo editar y reactivar). Null si
 * el workspace nunca tuvo uno.
 */
export async function getBrief(tx: WorkspaceTx): Promise<OutboundBrief | null> {
  const { rows } = await tx.query<BriefRowSql>(
    `${BRIEF_SELECT} ORDER BY (b.status = 'active') DESC, b.updated_at DESC, b.created_at DESC LIMIT 1`,
  );
  return rows[0] ? toBrief(rows[0]) : null;
}

/**
 * De quién es (o sería) el brief: el creador del brief guardado o, si no
 * hay, el creador principal del workspace (el primero activo, como
 * Cotizar). Null si el workspace no tiene ninguno: la pantalla lo dice
 * en vez de ofrecer un formulario que no podría guardar (NoCreator).
 */
export async function getBriefOwner(tx: WorkspaceTx): Promise<{ id: string; displayName: string } | null> {
  const { rows } = await tx.query<{ id: string; display_name: string }>(
    `SELECT r.id, r.display_name FROM (
       SELECT cp.id, cp.display_name, 0 AS o
         FROM creator_profile cp
        WHERE cp.id = (SELECT b.creator_id FROM outbound_brief b
                        ORDER BY (b.status = 'active') DESC, b.updated_at DESC, b.created_at DESC LIMIT 1)
       UNION ALL
       (SELECT cp.id, cp.display_name, 1 AS o
          FROM creator_profile cp
         WHERE cp.status = 'active' AND cp.deleted_at IS NULL
         ORDER BY cp.created_at
         LIMIT 1)
     ) r
     ORDER BY r.o
     LIMIT 1`,
  );
  return rows[0] ? { id: rows[0].id, displayName: rows[0].display_name } : null;
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

/** Las empresas del CRM que se pueden excluir: id y nombre, por nombre. */
export async function listBriefCompanyOptions(tx: WorkspaceTx): Promise<{ id: string; name: string }[]> {
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT co.id, co.name
       FROM company_link cl
       JOIN company co ON co.id = cl.company_id
      ORDER BY lower(co.name), co.id
      LIMIT 1000`,
  );
  return rows;
}

// ---------------------------------------------------------------------
// El radar: qué oculta el brief activo
// ---------------------------------------------------------------------

/**
 * La expresión SQL que dice por qué el brief ACTIVO deja fuera una
 * señal: 'company', 'category' o NULL (la señal se ve). `s` es el alias
 * de `signal` en la consulta que la usa; el texto es constante (no
 * lleva nada que venga de fuera), así que se puede componer.
 *
 * Mira solo la fila de la señal (company_id y evidence), igual en la
 * bandeja que en los conteos, para que «5 por revisar» y las tarjetas
 * cuadren siempre:
 *
 *   · Empresa excluida: la de la señal, o —si todavía no tiene— la que
 *     tiene su mismo dominio o, sin dominio, su mismo nombre (brand_key),
 *     como la reconocería acceptSignal.
 *   · Categoría excluida: el sector y los nichos de esa empresa, y lo que
 *     trae la señal en evidence (industry, category, brief_category),
 *     comparados con brand_key.
 *
 * Sin brief activo no hay fila en outbound_brief y la expresión es NULL:
 * no se oculta nada.
 */
export function briefVerdictSql(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`briefVerdictSql: alias inválido «${s}»`);
  const empresa = `(co.id = ${s}.company_id
                    OR (${s}.company_id IS NULL AND nullif(${s}.evidence->>'domain', '') IS NOT NULL
                        AND co.domain = lower(${s}.evidence->>'domain')))`;
  return `(SELECT CASE
             WHEN EXISTS (
               SELECT 1 FROM company ex
                WHERE ex.id = ANY (b.excluded_companies)
                  AND (ex.id = ${s}.company_id
                       OR (${s}.company_id IS NULL AND nullif(${s}.evidence->>'domain', '') IS NOT NULL
                           AND ex.domain = lower(${s}.evidence->>'domain'))
                       OR (${s}.company_id IS NULL AND nullif(${s}.evidence->>'domain', '') IS NULL
                           AND brand_key(ex.name) = brand_key(${s}.evidence->>'company_name'))))
               THEN 'company'
             WHEN EXISTS (
               SELECT 1
                 FROM unnest(b.excluded_categories) e(cat)
                WHERE brand_key(e.cat) IN (
                        SELECT brand_key(x.cat) FROM (
                          SELECT co.industry AS cat FROM company co WHERE ${empresa}
                          UNION ALL SELECT unnest(co.niche_slugs) FROM company co WHERE ${empresa}
                          UNION ALL SELECT ${s}.evidence->>'industry'
                          UNION ALL SELECT ${s}.evidence->>'category'
                          UNION ALL SELECT ${s}.evidence->>'brief_category'
                        ) x
                        WHERE brand_key(x.cat) IS NOT NULL))
               THEN 'category'
           END
      FROM outbound_brief b
     WHERE b.status = 'active'
     LIMIT 1)`;
}

/** Cuántas señales PENDIENTES deja fuera el brief activo, y por qué. */
export interface HiddenSignals {
  total: number;
  byCompany: number;
  byCategory: number;
}

/** Lo que la bandeja dice debajo del título: «3 señales ocultas por tu brief». */
export async function countHiddenSignals(tx: WorkspaceTx): Promise<HiddenSignals> {
  const { rows } = await tx.query<{ total: string; by_company: string; by_category: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE v.verdict = 'company')::text  AS by_company,
            count(*) FILTER (WHERE v.verdict = 'category')::text AS by_category
       FROM signal s
      CROSS JOIN LATERAL (SELECT ${briefVerdictSql('s')} AS verdict) v
      WHERE s.status = 'pending' AND v.verdict IS NOT NULL`,
  );
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

/**
 * La clave con la que se comparan dos categorías en TypeScript: la misma
 * idea que brand_key en SQL (sin tildes, sin mayúsculas, sin signos).
 * Solo sirve para no guardar «Alcohol» y «alcohol» dos veces; la
 * comparación con las señales la hace la base con brand_key.
 */
export function categoryKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DELIVERABLE_RE = /^[a-z_]{1,40}$/;

function validDate(v: string | null): boolean {
  if (v === null) return true;
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Guarda el brief del workspace: actualiza el que devuelve getBrief o,
 * si no hay ninguno, lo crea para el creador principal (el primero
 * activo, como Cotizar). Devuelve su id.
 *
 * Valida aquí lo mismo que los CHECK de 0043 y algo más que la base no
 * puede saber: que una categoría no esté a la vez en «busco» y en «no
 * acepto» (CategoryConflict), y que las empresas excluidas sean del CRM
 * de este workspace (CompanyNotInCrm): un uuid ajeno no oculta nada,
 * pero tampoco se guarda.
 *
 * Los entregables conservan lo que ya tenían (la etiqueta y el rango que
 * trae el seed desde el tarifario) si siguen elegidos.
 */
export async function saveBrief(tx: WorkspaceTx, input: SaveBriefInput): Promise<string> {
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
  if (!CURRENCY_RE.test(currency)) throw new BriefError('InvalidBudget');

  const from = input.availabilityFrom?.trim() || null;
  const to = input.availabilityTo?.trim() || null;
  if (!validDate(from) || !validDate(to) || (from !== null && to !== null && to < from)) {
    throw new BriefError('InvalidWindow');
  }

  const kinds = [...new Set(input.deliverables.map((d) => d.trim()).filter(Boolean))];
  if (kinds.some((k) => !DELIVERABLE_RE.test(k))) throw new BriefError('InvalidDeliverable');

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

  const { rows: actual } = await tx.query<{ id: string; deliverables: BriefDeliverable[] }>(
    `SELECT id, deliverables FROM outbound_brief
      ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC
      LIMIT 1
        FOR UPDATE`,
  );
  const previos = new Map(
    (Array.isArray(actual[0]?.deliverables) ? actual[0].deliverables : [])
      .filter((d) => d && typeof d.kind === 'string')
      .map((d) => [d.kind, d] as const),
  );
  const deliverables = kinds.map((kind) => previos.get(kind) ?? { kind });
  const status: BriefStatus = input.active ? 'active' : 'paused';

  const valores = [
    title, wanted, countries, minBudget, currency, JSON.stringify(deliverables), from, to,
    excluded, companyIds, input.requiresDisclosure, notes, status,
  ];

  if (actual[0]) {
    await tx.query(
      `UPDATE outbound_brief
          SET title = $2, wanted_categories = $3, wanted_countries = $4, min_budget = $5::numeric,
              currency = $6, deliverables = $7::jsonb, availability_from = $8::date, availability_to = $9::date,
              excluded_categories = $10, excluded_companies = $11::uuid[], requires_disclosure = $12,
              notes = $13, status = $14
        WHERE id = $1`,
      [actual[0].id, ...valores],
    );
    return actual[0].id;
  }

  const { rows: creador } = await tx.query<{ id: string }>(
    "SELECT id FROM creator_profile WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
  );
  if (!creador[0]) throw new BriefError('NoCreator');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_brief (workspace_id, creator_id, title, wanted_categories, wanted_countries, min_budget,
                                 currency, deliverables, availability_from, availability_to, excluded_categories,
                                 excluded_companies, requires_disclosure, notes, status)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5::numeric, $6, $7::jsonb, $8::date, $9::date, $10,
             $11::uuid[], $12, $13, $14)
     RETURNING id`,
    [creador[0].id, ...valores],
  );
  return rows[0]!.id;
}
