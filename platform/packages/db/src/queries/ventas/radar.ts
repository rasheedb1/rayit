/**
 * Ventas · el radar de señales (VEN-2): listarlas, crearlas a mano o por
 * CSV, aceptarlas (empresa, negocio y la acción de enviar el pitch),
 * descartarlas y rechazar una marca. Dueño: Rasheed.
 */
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { audit } from '../../audit.ts';
import { ScopeError } from '../../scope.ts';
import { addExcludedCompany, BRIEF_LIMITS, BriefError, briefSignalLateralSql, briefVerdictSql, type BriefVerdict } from '../brief.ts';
import { CompanyNotFound, DealNotFound, DuplicateCompanyName, normalizeDomain, SignalAlreadyReviewed, SignalNotFound, type SignalRow, type SignalStatus, VentasError } from './comun.ts';
import { dueInBusinessDays, normalizeCountry, safeLimit, type SignalRowSql, toSignalRow, truncate } from './interno.ts';

export interface ListSignalsParams {
  status?: SignalStatus;
  /** 1..200. Por defecto 100. */
  limit?: number;
  /**
   * Qué hacer con las pendientes que el brief activo no acepta (VEN-7):
   * 'apply' (por defecto) las deja fuera; 'show_hidden' las trae todas,
   * con `hiddenBy` diciendo por qué se ocultarían. En los demás estados
   * no se filtra nada: lo aceptado y lo descartado ya se decidió.
   */
  brief?: 'apply' | 'show_hidden';
}

/** Las columnas del veredicto cuando no se aplica el brief (lo que no está pendiente ya se decidió). */
const SIN_VEREDICTO =
  'SELECT NULL::text AS hidden_by, NULL::text AS hidden_match, NULL::text AS wanted_match, false AS below_min_budget, false AS country_outside, false AS category_outside';

/**
 * La bandeja del radar. Por defecto las pendientes, de mayor a menor
 * encaje: es el orden en que se revisan. Las pendientes que el brief
 * activo excluye no vienen (VEN-7), salvo con `brief: 'show_hidden'`,
 * que las trae al final. Cada una dice cómo encaja con «Qué buscas»
 * (briefFit) sin que eso oculte ninguna.
 */
export async function listSignals(tx: WorkspaceTx, params: ListSignalsParams = {}): Promise<SignalRow[]> {
  const status = params.status ?? 'pending';
  const limit = safeLimit(params.limit, 100, 200);
  const aplicaBrief = status === 'pending';
  const ocultar = aplicaBrief && (params.brief ?? 'apply') === 'apply';
  const { rows } = await tx.query<SignalRowSql>(
    // Una señal manual o de CSV no tiene company_id hasta que se acepta:
    // el nombre y el dominio que se escribieron viven en `evidence`.
    //
    // La empresa y el negocio abierto se resuelven como en acceptSignal
    // (resolveCompany y su «¿ya hay un negocio abierto?»), para que la
    // tarjeta diga ANTES de aceptar lo que va a pasar: «Ya en tu CRM» y
    // «Se sumará a <negocio>» en vez de otro negocio (pulido r8).
    `SELECT s.id, emp.id AS company_id,
            COALESCE(co.name, s.evidence->>'company_name')              AS company_name,
            COALESCE(co.domain::text, s.evidence->>'domain')            AS company_domain,
            (cl.company_id IS NOT NULL) AS company_linked,
            abierto.id AS open_deal_id, abierto.name AS open_deal_name, coalesce(abierto.total, 0)::int AS open_deal_count,
            s.source_id, COALESCE(src.label_es, s.source_id) AS source_label,
            s.headline_es, s.detected_at, s.evidence_url, s.fit_score::text AS fit_score,
            s.budget_estimate::text AS budget_estimate, s.budget_currency::text AS budget_currency,
            s.dedupe_key, s.status, s.discard_reason, s.reviewed_at,
            COALESCE(s.evidence->>'via', 'manual') AS via,
            veredicto.hidden_by, veredicto.hidden_match, veredicto.wanted_match,
            veredicto.below_min_budget, veredicto.country_outside, veredicto.category_outside
     FROM signal s
     CROSS JOIN LATERAL (${aplicaBrief ? briefSignalLateralSql('s') : SIN_VEREDICTO}) veredicto
     LEFT JOIN company co        ON co.id = s.company_id
     LEFT JOIN LATERAL (
            SELECT r.id FROM (
              (SELECT c.id, 0 AS o
                 FROM company c
                WHERE s.company_id IS NULL
                  AND nullif(s.evidence->>'domain', '') IS NOT NULL
                  AND c.domain::text = lower(s.evidence->>'domain')
                LIMIT 1)
              UNION ALL
              (SELECT c.id, 1 AS o
                 FROM company_link l
                 JOIN company c ON c.id = l.company_id
                WHERE s.company_id IS NULL
                  AND (nullif(s.evidence->>'domain', '') IS NULL OR c.domain IS NULL)
                  AND c.name_key = brand_key(s.evidence->>'company_name')
                ORDER BY (c.domain IS NULL) ASC, l.created_at ASC
                LIMIT 1)
            ) r
            ORDER BY r.o
            LIMIT 1
          ) resuelta ON true
     CROSS JOIN LATERAL (SELECT COALESCE(s.company_id, resuelta.id) AS id) emp
     LEFT JOIN company_link cl   ON cl.company_id = emp.id
     LEFT JOIN LATERAL (
            SELECT d.id, d.name, count(*) OVER () AS total
              FROM deal d
              JOIN pipeline_stage st ON st.id = d.stage_id
             WHERE d.company_id = emp.id AND NOT st.is_won AND NOT st.is_lost
             ORDER BY st.position DESC, d.created_at DESC
             LIMIT 1
          ) abierto ON true
     LEFT JOIN signal_source src ON src.id = s.source_id
     WHERE s.status = $1${ocultar ? ' AND veredicto.hidden_by IS NULL' : ''}
     -- Con «Verlas», las ocultas van al final, en su propio grupo: no
     -- mezcladas por encaje con las que sí se ven.
     ORDER BY (veredicto.hidden_by IS NOT NULL), s.fit_score DESC NULLS LAST, s.detected_at DESC
     LIMIT $2`,
    [status, limit],
  );
  return rows.map(toSignalRow);
}

/**
 * Cuántas señales esperan revisión. Lo pinta el KPI y la pestaña. Las
 * que el brief activo oculta no cuentan (VEN-7): son las de la bandeja.
 */
export async function countPendingSignals(tx: WorkspaceTx): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM signal s WHERE s.status = 'pending' AND ${briefVerdictSql('s')} IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * La clave con la que una señal se reconoce como la misma.
 *
 * Determinista y estable: si una señal vuelve a entrar con la misma
 * clave, el UNIQUE (workspace_id, dedupe_key) la rechaza y no reaparece
 * en la bandeja. Por eso la clave NO lleva la fecha de hoy —eso haría
 * «nueva» a la misma señal cada mañana— sino la fuente, el
 * identificador de la empresa y, si la hay, la referencia propia de la
 * señal (el anuncio, la vacante, la semana del ranking; en una manual o
 * de CSV, su titular: ver signalRef).
 */
export function buildDedupeKey(sourceId: string, companyKey: string, ref?: string | null): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');
  const parts = [norm(sourceId), norm(companyKey)];
  if (ref?.trim()) parts.push(norm(ref));
  return parts.join(':');
}

/**
 * La referencia propia de una señal escrita a mano o traída de un CSV:
 * su titular, sin tildes, mayúsculas ni signos, y acotado.
 *
 * Sin ella la clave era solo fuente:marca, y el UNIQUE bloqueaba para
 * siempre cualquier señal nueva de una marca ya aceptada, que es
 * justo lo que el radar dice que NO hace (findBrandSignal: una señal
 * nueva de una marca que ya está en el CRM es información). Con el
 * titular, el UNIQUE solo frena la MISMA señal repetida: «Lanzó cold
 * brew» dos veces es una; «Lanzó cold brew» y «Abre tienda en Medellín»
 * son dos. Pendientes y descartadas no dependen de esto: las frena
 * findBrandSignal por la marca, con cualquier titular.
 */
export function signalRef(headline: string): string | null {
  const ref = headline
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return ref || null;
}

export interface CreateSignalInput {
  /** Empresa ya vinculada, o los datos para crearla al aceptar. */
  companyId?: string | null;
  companyName?: string | null;
  domain?: string | null;
  country?: string | null;
  industry?: string | null;
  headlineEs: string;
  evidenceUrl?: string | null;
  /** 0..1 como string decimal. */
  fitScore?: string | null;
  budgetEstimate?: string | null;
  note?: string | null;
  /** Por defecto `manual`: lo que escribe una persona. */
  sourceId?: string;
  /**
   * Cómo llegó la señal dentro de su fuente: a mano o por una lista.
   *
   * No es una fila nueva de `signal_source` a propósito. Las dos son
   * «añadida a mano» para el catálogo, y darles fuentes distintas las
   * separaría también en la clave de deduplicación: la misma marca
   * entraría dos veces, una por cada camino, que es justo lo que el
   * radar existe para evitar. Queda en `evidence` porque es contexto de
   * ESA señal, no una fuente distinta.
   */
  via?: SignalVia;
}

/** Por dónde entró una señal manual. */
export type SignalVia = 'manual' | 'csv';

export interface CreateSignalResult {
  id: string | null;
  /** No se creó: la marca ya estaba en el radar (ver `reason`). */
  duplicate: boolean;
  /**
   * Por qué no entró: 'pending', la marca ya tiene una señal en la
   * bandeja; 'discarded', la marca se descartó antes; 'accepted', esa
   * misma señal ya se aceptó y la marca es un negocio (companyId dice
   * cuál); 'same_key', la misma señal de la misma fuente en otro estado
   * (el UNIQUE de la base). Null si entró.
   */
  reason: SignalDuplicateReason | null;
  dedupeKey: string;
  /**
   * La empresa de la señal que ya estaba, cuando se conoce (siempre en
   * 'accepted'): la pantalla enlaza a su ficha en vez de solo decir que
   * no entró.
   */
  companyId: string | null;
  /**
   * Entró, pero el brief activo la deja fuera de la bandeja (VEN-7): la
   * pantalla lo dice en vez de anunciar «ya está en la bandeja». Null si
   * se ve, o si no entró.
   */
  hiddenBy: BriefVerdict | null;
}

export type SignalDuplicateReason = 'same_key' | 'pending' | 'discarded' | 'accepted';

/** Una empresa ya conocida, resuelta a partir de lo que se escribió. */
interface ResolvedCompany {
  id: string;
  name: string;
  domain: string | null;
}

/**
 * Qué hacer con una empresa del CRM que se llama igual y tiene otro
 * dominio: preguntar (aceptar una señal, con la respuesta si ya la hay)
 * o usarla (no aceptar una marca desde el brief).
 */
type SameNamePolicy = { ask: true; choice?: SameNameChoice | null } | { ask: false };

/**
 * La empresa que ya conocemos detrás de un id, un dominio o un nombre.
 *
 *   - Por id: la visible (la mía o la del catálogo compartido).
 *   - Por dominio: cualquiera visible con ese dominio. El dominio es
 *     único en el catálogo, así que es la misma marca.
 *   - Por nombre: entre las empresas de MI CRM (company_link),
 *     comparando brand_key (sin tildes, mayúsculas ni signos: «Nutrivé»
 *     = «NUTRIVE»). Fuera de mi CRM un nombre no basta: dos «Alma» de
 *     dos países no son la misma marca, y ni siquiera se ven. Si vino un
 *     dominio que nadie tiene, el nombre solo casa con una empresa de mi
 *     CRM SIN dominio (la misma regla que el veredicto del brief,
 *     signalCompanyRowsSql): la marca que se excluyó por su nombre
 *     («No aceptar «Marca Rival»») es la de la señal que llega con
 *     marcarival.co, y aceptarla no crea un duplicado fuera del brief.
 */
async function resolveCompany(
  tx: WorkspaceTx,
  input: { companyId?: string | null; domain?: string | null; name?: string | null },
): Promise<ResolvedCompany | null> {
  type Row = { id: string; name: string; domain: string | null };
  if (input.companyId) {
    if (!isUuid(input.companyId)) return null;
    const { rows } = await tx.query<Row>('SELECT id, name, domain::text AS domain FROM company WHERE id = $1', [input.companyId]);
    return rows[0] ?? null;
  }
  const domain = normalizeDomain(input.domain);
  if (domain) {
    const { rows } = await tx.query<Row>('SELECT id, name, domain::text AS domain FROM company WHERE domain = $1 LIMIT 1', [domain]);
    if (rows[0]) return rows[0];
  }
  const name = input.name?.trim();
  if (!name) return null;
  const { rows } = await tx.query<Row>(
    `SELECT co.id, co.name, co.domain::text AS domain
       FROM company_link cl
       JOIN company co ON co.id = cl.company_id
      WHERE co.name_key = brand_key($1) AND ($2::text IS NULL OR co.domain IS NULL)
      ORDER BY (co.domain IS NULL) ASC, cl.created_at ASC
      LIMIT 1`,
    [name, domain],
  );
  return rows[0] ?? null;
}

/**
 * ¿La marca ya tiene una señal pendiente o descartada en este
 * workspace, venga de la fuente que venga? Es la regla del radar: una
 * marca que ya está en la bandeja no se repite, y una que se descartó
 * no vuelve a entrar ni por otra fuente, ni por una lista, ni a mano.
 * Las aceptadas no cuentan: esa marca ya está en el CRM y una señal
 * nueva suya (otra campaña, otra temporada) es información.
 *
 * Se reconoce la marca por la empresa (si ya está resuelta), por el
 * dominio, o por el nombre cuando a uno de los dos lados le falta el
 * dominio. Dos marcas con el mismo nombre y dominios distintos no son
 * la misma.
 */
async function findBrandSignal(
  tx: WorkspaceTx,
  brand: { companyId: string | null; domain: string | null; name: string | null },
): Promise<'pending' | 'discarded' | null> {
  const { rows } = await tx.query<{ status: 'pending' | 'discarded' }>(
    `SELECT s.status
       FROM signal s
       LEFT JOIN company co ON co.id = s.company_id
      WHERE s.status IN ('pending', 'discarded')
        AND (
              ($1::uuid IS NOT NULL AND s.company_id = $1)
           OR ($2::text IS NOT NULL AND lower(coalesce(co.domain::text, s.evidence->>'domain')) = $2)
           OR ($3::text IS NOT NULL
               AND brand_key(coalesce(co.name, s.evidence->>'company_name')) = brand_key($3)
               AND ($2::text IS NULL OR coalesce(co.domain::text, s.evidence->>'domain') IS NULL))
            )
      ORDER BY (s.status = 'discarded') DESC
      LIMIT 1`,
    [brand.companyId, brand.domain, brand.name],
  );
  return rows[0]?.status ?? null;
}

/**
 * Una señal escrita a mano o traída de un CSV de marcas.
 *
 * Si la marca ya es una empresa conocida (por su id, su dominio o, sin
 * dominio, su nombre dentro de mi CRM), la señal queda enlazada a ella;
 * si no, la empresa nace al aceptarla, con lo que se guarda en
 * `evidence` (dominio, país y sector) para no volver a teclearlo.
 *
 * Antes de insertar se mira la marca, no solo la clave: una marca con
 * una señal pendiente o descartada no entra otra vez por ningún camino
 * (findBrandSignal). Una marca ya ACEPTADA sí admite señales nuevas
 * (otra campaña, otra temporada): la clave lleva el titular (signalRef)
 * y su UNIQUE solo frena la misma señal repetida. Cuando frena una que
 * ya se aceptó, el resultado lo dice ('accepted', con la empresa) para
 * que la pantalla mande a la ficha y no hable de un descarte que no hubo.
 */
export async function createSignal(tx: WorkspaceTx, input: CreateSignalInput): Promise<CreateSignalResult> {
  const headline = input.headlineEs.trim();
  if (!headline) throw new VentasError('InvalidHeadline');
  const sourceId = input.sourceId?.trim() || 'manual';
  const domain = normalizeDomain(input.domain);
  const companyName = input.companyName?.trim() || null;
  if (!input.companyId && !companyName && !domain) {
    throw new VentasError('InvalidCompany');
  }
  if (input.companyId && !isUuid(input.companyId)) throw new CompanyNotFound();

  const company = await resolveCompany(tx, { companyId: input.companyId, domain, name: companyName });
  if (input.companyId && !company) throw new CompanyNotFound();

  const brandDomain = domain ?? normalizeDomain(company?.domain);
  const companyKey = brandDomain ?? companyName ?? company?.name ?? input.companyId ?? '';
  const dedupeKey = buildDedupeKey(sourceId, companyKey, signalRef(headline));

  const previa = await findBrandSignal(tx, {
    companyId: company?.id ?? null,
    domain: brandDomain,
    name: companyName ?? company?.name ?? null,
  });
  if (previa) return { id: null, duplicate: true, reason: previa, dedupeKey, companyId: company?.id ?? null, hiddenBy: null };

  const evidence = {
    company_name: companyName ?? company?.name ?? null,
    domain: brandDomain,
    country: normalizeCountry(input.country),
    industry: input.industry?.trim() || null,
    note: input.note?.trim() || null,
    via: input.via ?? 'manual',
  };

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO signal (workspace_id, company_id, source_id, headline_es, evidence_url, evidence,
                         fit_score, budget_estimate, budget_currency, dedupe_key, status)
     SELECT current_workspace_id(), $1, $2, $3, $4, $5::jsonb, $6::numeric, $7::numeric,
            CASE WHEN $7::numeric IS NULL THEN NULL ELSE w.currency END, $8, 'pending'
     FROM workspace w WHERE w.id = current_workspace_id()
     ON CONFLICT (workspace_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      company?.id ?? null,
      sourceId,
      headline,
      input.evidenceUrl?.trim() || null,
      JSON.stringify(evidence),
      input.fitScore ?? null,
      input.budgetEstimate ?? null,
      dedupeKey,
    ],
  );
  const id = rows[0]?.id ?? null;
  if (id) {
    const { rows: veredicto } = await tx.query<{ hidden_by: BriefVerdict | null }>(
      `SELECT ${briefVerdictSql('s')} AS hidden_by FROM signal s WHERE s.id = $1`,
      [id],
    );
    return { id, duplicate: false, reason: null, dedupeKey, companyId: company?.id ?? null, hiddenBy: veredicto[0]?.hidden_by ?? null };
  }

  // La clave chocó: ¿con qué? La fila que ya la ocupa dice si esa misma
  // señal se aceptó (la marca es un negocio), sigue en la bandeja o se
  // descartó; el aviso de la pantalla depende de eso.
  const { rows: ocupada } = await tx.query<{ status: SignalStatus; company_id: string | null }>(
    'SELECT status, company_id FROM signal WHERE dedupe_key = $1 LIMIT 1',
    [dedupeKey],
  );
  const previaClave = ocupada[0];
  const reason: SignalDuplicateReason =
    previaClave?.status === 'accepted' || previaClave?.status === 'pending' || previaClave?.status === 'discarded'
      ? previaClave.status
      : 'same_key';
  return { id: null, duplicate: true, reason, dedupeKey, companyId: previaClave?.company_id ?? company?.id ?? null, hiddenBy: null };
}

export interface ImportSignalRow {
  name: string;
  domain?: string | null;
  country?: string | null;
  industry?: string | null;
  note?: string | null;
}

export interface ImportSignalsResult {
  created: number;
  duplicated: number;
  /** Clave de cada fila que ya existía, en el orden del archivo. */
  duplicatedKeys: string[];
  /**
   * El índice (en `rows`, desde 0) de cada fila que entró DE VERDAD, en
   * orden. La pantalla lo usa para no decir «entró con un aviso» de una
   * fila repetida que no entró (pulido r7).
   */
  createdRows: number[];
  /** De las que entraron, cuántas deja fuera de la bandeja el brief activo (VEN-7). */
  hiddenByBrief: number;
}

export interface ImportSignalsOptions {
  /**
   * El titular de una fila sin nota. La frase la pone la pantalla (esta
   * capa no tiene idioma); sin ella, el titular es el nombre de la marca.
   */
  headline?: (name: string) => string;
}

/**
 * Carga una lista de marcas como señales pendientes. Una marca que ya
 * está en el radar —pendiente o descartada, entrara por donde entrara—
 * no vuelve a entrar: lo decide createSignal con la base, no un filtro
 * en la pantalla, que se olvidaría en el siguiente archivo. Dos filas
 * de la misma marca en el mismo archivo entran una vez.
 */
export async function importSignals(
  tx: WorkspaceTx,
  rows: ImportSignalRow[],
  opts: ImportSignalsOptions = {},
): Promise<ImportSignalsResult> {
  const createdRows: number[] = [];
  const duplicatedKeys: string[] = [];
  let hiddenByBrief = 0;
  for (const [i, row] of rows.entries()) {
    const name = row.name.trim();
    const res = await createSignal(tx, {
      companyName: name,
      domain: row.domain,
      country: row.country,
      industry: row.industry,
      note: row.note,
      headlineEs: row.note?.trim() || (opts.headline ? opts.headline(name) : name),
      via: 'csv',
    });
    if (res.duplicate) duplicatedKeys.push(res.dedupeKey);
    else createdRows.push(i);
    if (res.hiddenBy) hiddenByBrief++;
  }
  return { created: createdRows.length, duplicated: duplicatedKeys.length, duplicatedKeys, createdRows, hiddenByBrief };
}

export interface AcceptSignalResult {
  dealId: string;
  companyId: string;
  companyName: string;
  /** La empresa nació al aceptar la señal. */
  companyCreated: boolean;
  /**
   * Se abrió un negocio nuevo. False cuando la marca ya tenía uno
   * abierto: la señal se suma a ese (queda en su historia) y `dealId`
   * es el que ya existía, para que la pantalla diga «Ya tienes un
   * negocio con X» en vez de abrir un segundo.
   */
  dealCreated: boolean;
}

export interface AcceptSignalOptions {
  /** La siguiente acción del negocio nuevo, en el idioma de la pantalla. Por defecto, PITCH_ACTION. */
  nextAction?: string;
  /** El cuerpo de la actividad que cuenta de dónde salió el negocio. */
  activityBody?: string;
  /**
   * El título del negocio nuevo cuando la señal no dice nada más que la
   * marca, en el idioma de la pantalla. Por defecto, PENDING_DEAL_NAME.
   */
  pendingDealName?: string;
  /** Desde cuándo se cuentan los días hábiles del pitch. Por defecto, now() de la base; lo fijan las pruebas. */
  now?: Date;
  /**
   * La respuesta a «¿Es la misma X de tu CRM?» (pulido r2). La señal trae
   * un dominio que nadie tiene y el CRM ya tiene una empresa con el mismo
   * nombre y OTRO dominio (marca.com y marca.co): sin respuesta,
   * acceptSignal lanza DuplicateCompanyName y la tarjeta pregunta.
   * `useCompanyId`: es la misma, la señal se suma a esa empresa (solo si
   * es una del CRM con ese nombre). `createAnyway`: es otra marca, con el
   * nombre por el que se preguntó, como allowSameNameAs en createCompany.
   */
  sameName?: SameNameChoice | null;
}

/** Qué dijo la persona de una marca que se llama como una del CRM con otro dominio. */
export type SameNameChoice = { useCompanyId: string } | { createAnyway: string };

/**
 * El título de un negocio que nace de una señal sin nada propio que
 * contar: como «Olla Fácil · Por definir» en el seed. Llamarlo como la
 * marca era peor: Cotizar pintaba «Panadería Aurora / Panadería Aurora».
 */
export const PENDING_DEAL_NAME = 'Por definir';

/** «Panadería Aurora», «PANADERIA AURORA» y « panaderia-aurora » son el mismo nombre. */
function nameKey(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * El título del negocio que abre una señal aceptada (pulido r4).
 *
 * Es el titular de la señal —«Abre 3 tiendas en Bogotá»—, que es lo que
 * la persona vio y lo único que distingue este negocio de otro de la
 * misma marca. Salvo cuando el titular no es de nadie: una fila de CSV
 * sin nota (la pantalla lo inventa a partir del nombre: «X entró por una
 * lista de marcas») o un titular que es solo el nombre de la marca. Ahí
 * el negocio queda «Por definir», como en el seed, y nunca repite la marca.
 */
export function dealNameFromSignal(
  headline: string,
  evidence: Record<string, unknown>,
  brandNames: (string | null | undefined)[],
  pendingName?: string,
): string {
  const titular = headline.trim();
  const note = typeof evidence.note === 'string' ? evidence.note.trim() : '';
  const inventado = evidence.via === 'csv' && !note;
  const key = nameKey(titular);
  const esLaMarca = brandNames.some((n) => typeof n === 'string' && nameKey(n) === key);
  if (!titular || !key || inventado || esLaMarca) return pendingName?.trim() || PENDING_DEAL_NAME;
  return titular;
}

/**
 * Días HÁBILES (lunes a viernes) que se le dan al primer pitch cuando se
 * acepta una señal o se abre un negocio a mano. Hábiles, como el
 * seguimiento de una cotización (FOLLOW_UP_BUSINESS_DAYS): con días de
 * calendario, una señal aceptada el miércoles vencía el sábado y el
 * lunes el tablero decía «Vencido» por algo que tocaba en fin de semana
 * (pulido r7).
 */
export const PITCH_DUE_BUSINESS_DAYS = 3;

/**
 * El TEXTO de la siguiente acción con la que nace un negocio si la
 * pantalla no da otro. Solo es un respaldo: la web pasa siempre el suyo
 * (MESSAGES.radar.pitchAction) y nada compara contra este literal. Lo
 * que dice «esta siguiente acción es el pitch» es la columna
 * deal.next_action_kind = 'pitch' (0032), no la frase: un espacio en
 * otro idioma guarda su frase y el marcador sigue siendo el mismo.
 */
export const PITCH_ACTION = 'Enviar pitch';

/** A qué hora LOCAL del workspace vence la siguiente acción de un negocio nuevo. */
export const PITCH_DUE_HOUR = 15;

/**
 * El workspace actual con su zona, para las consultas que la necesitan.
 * La usa también queries/ventas-ficha.ts (VEN-4, VEN-5): una sola
 * definición de «la zona del espacio».
 *
 * La zona se usa tal cual en `AT TIME ZONE` sin validarla aquí: la
 * migración 0044 corrigió las que estaban mal escritas y su disparador
 * (workspace_timezone_check) no deja guardar ninguna que Postgres no
 * conozca. Validar en cada lectura contra pg_timezone_names costaría un
 * recorrido del catálogo de zonas por consulta. Vacía cae en UTC, como
 * en Cotizar (sendQuote), aunque 0044 tampoco deja guardarla.
 */
export const WORKSPACE_TZ = `(SELECT id, currency, coalesce(nullif(timezone, ''), 'UTC') AS tz
    FROM workspace WHERE id = current_workspace_id())`;

/**
 * La empresa que ya conocemos por dominio o, sin dominio, por nombre
 * dentro del CRM (resolveCompany), o una nueva con lo que se sabe de ella
 * (nombre, dominio, país y sector). Null si no la conocemos y tampoco
 * hay nombre: no hay marca que dar de alta. La usan la señal
 * (companyOfSignal) y «No aceptar «…»» desde el brief (rejectBrandByName):
 * una sola forma de dar de alta una marca.
 */
async function findOrCreateCompany(
  tx: WorkspaceTx,
  input: { name: string | null; domain: string | null; country?: string | null; industry?: string | null },
  sameName: SameNamePolicy = { ask: false },
): Promise<{ company: ResolvedCompany; created: boolean } | null> {
  const existente = await resolveCompany(tx, { domain: input.domain, name: input.name });
  if (existente) return { company: existente, created: false };
  const name = input.name?.trim();
  if (!name) return null;
  const domain = normalizeDomain(input.domain);
  // resolveCompany no casa un nombre del CRM que tiene OTRO dominio (dos
  // «Alma» de dos países no son la misma). Pero crear en silencio una
  // segunda «Molino Andino» porque la señal trae molinoandino.co y la
  // ficha molinoandino.test deja la ficha real sin su negocio (pulido r2).
  // Con `ask`, se pregunta; sin él (no aceptar una marca desde el brief),
  // se usa la del CRM: excluir por nombre excluye a esa.
  const choice = sameName.ask ? (sameName.choice ?? null) : null;
  const { rows: mismoNombre } = await tx.query<ResolvedCompany & { confirmed: boolean | null }>(
    `SELECT co.id, co.name, co.domain::text AS domain, brand_key(co.name) = brand_key($2::text) AS confirmed
       FROM company_link cl
       JOIN company co ON co.id = cl.company_id
      WHERE co.name_key = brand_key($1)
      ORDER BY cl.created_at ASC`,
    [name, choice && 'createAnyway' in choice ? choice.createAnyway.trim() || null : null],
  );
  const primera = mismoNombre[0];
  if (primera) {
    const elegida = choice && 'useCompanyId' in choice ? mismoNombre.find((c) => c.id === choice.useCompanyId) : undefined;
    const usar = elegida ?? (sameName.ask ? undefined : primera);
    if (usar) return { company: { id: usar.id, name: usar.name, domain: usar.domain }, created: false };
    if (primera.confirmed !== true) throw new DuplicateCompanyName(primera.name, primera.id);
  }
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO company (name, domain, country, industry) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, domain, normalizeCountry(input.country), input.industry ?? null],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new VentasError('CompanyCreateFailed');
  return { company: { id, name, domain }, created: true };
}

/**
 * Enlaza la marca al CRM con la relación 'blocked' si no estaba. Si ya
 * estaba, su relación no se toca: un cliente sigue siendo cliente.
 * Devuelve la relación que tenía antes (null si no estaba en el CRM).
 */
async function linkBlocked(tx: WorkspaceTx, companyId: string): Promise<string | null> {
  const { rows: antes } = await tx.query<{ relationship: string }>(
    'SELECT relationship FROM company_link WHERE company_id = $1',
    [companyId],
  );
  await tx.query(
    `INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship)
     VALUES (current_workspace_id(), $1, current_user_id(), 'blocked')
     ON CONFLICT (workspace_id, company_id) DO NOTHING`,
    [companyId],
  );
  return antes[0]?.relationship ?? null;
}

/**
 * La empresa de una señal, para aceptarla o para no aceptar su marca:
 * la que ya conocemos (por id, por dominio o, sin dominio, por nombre
 * dentro del CRM, resolveCompany) o, si no hay ninguna, una nueva con lo
 * que la señal guardó en `evidence` (nombre, dominio, país y sector).
 * Deja la señal enlazada a ella. Null si no hay empresa y la señal
 * tampoco trae nombre: no hay marca que dar de alta.
 */
async function companyOfSignal(
  tx: WorkspaceTx,
  sig: { id: string; company_id: string | null; evidence: Record<string, unknown> | null },
  sameName: SameNamePolicy = { ask: false },
): Promise<{ company: ResolvedCompany; created: boolean } | null> {
  const ev = sig.evidence ?? {};
  const texto = (k: string) => (typeof ev[k] === 'string' ? (ev[k] as string) : null);

  const conocida = sig.company_id ? await resolveCompany(tx, { companyId: sig.company_id }) : null;
  const resuelta = conocida
    ? { company: conocida, created: false }
    : await findOrCreateCompany(tx, {
        name: texto('company_name'),
        domain: texto('domain'),
        country: texto('country'),
        industry: texto('industry'),
      }, sameName);
  if (!resuelta) return null;
  if (sig.company_id !== resuelta.company.id) {
    await tx.query('UPDATE signal SET company_id = $2 WHERE id = $1', [sig.id, resuelta.company.id]);
  }
  return resuelta;
}

/**
 * Aceptar una señal: resuelve la empresa (la que ya conocemos por id,
 * dominio o, sin dominio, por nombre dentro del CRM; si no, la crea),
 * la vincula y:
 *
 *   - si la marca ya tiene un negocio abierto, la señal se suma a ese:
 *     queda su actividad en la historia del negocio y no se abre otro;
 *   - si no, abre un negocio en «nuevo» con «Enviar pitch» a tres días
 *     hábiles, su primera fila de historial y la actividad que lo explica.
 *
 * Todo en la misma transacción que abrió la pantalla: o queda entero o
 * no queda nada. `FOR UPDATE` sobre la señal evita que dos pestañas
 * abiertas creen dos negocios de la misma.
 */
export async function acceptSignal(
  tx: WorkspaceTx,
  signalId: string,
  opts: AcceptSignalOptions = {},
): Promise<AcceptSignalResult> {
  if (!isUuid(signalId)) throw new SignalNotFound();
  const { rows } = await tx.query<{
    id: string; company_id: string | null; status: SignalStatus; headline_es: string;
    evidence: Record<string, unknown>; budget_estimate: string | null; source_id: string;
  }>(
    `SELECT id, company_id, status, headline_es, evidence, budget_estimate::text AS budget_estimate, source_id
     FROM signal WHERE id = $1 FOR UPDATE`,
    [signalId],
  );
  const sig = rows[0];
  if (!sig) throw new SignalNotFound();
  if (sig.status !== 'pending') throw new SignalAlreadyReviewed();

  const ev = sig.evidence ?? {};
  const evName = typeof ev.company_name === 'string' ? ev.company_name : null;
  const resuelta = await companyOfSignal(tx, sig, { ask: true, choice: opts.sameName ?? null });
  if (!resuelta) throw new VentasError('SignalWithoutCompany');
  const { company, created: companyCreated } = resuelta;
  const companyId = company.id;

  // Vincular es idempotente: si ya era una empresa del workspace, se
  // deja la relación como estaba (podía ser cliente) y su responsable.
  // Si es nueva, su responsable es quien aceptó la señal.
  await tx.query(
    `INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship)
     VALUES (current_workspace_id(), $1, current_user_id(), 'prospect')
     ON CONFLICT (workspace_id, company_id) DO NOTHING`,
    [companyId],
  );

  const metadata = JSON.stringify({ signal_id: signalId, source_id: sig.source_id });
  const markAccepted = () =>
    tx.query(
      `UPDATE signal SET status = 'accepted', reviewed_by = current_user_id(), reviewed_at = now() WHERE id = $1`,
      [signalId],
    );

  // ¿Ya hay un negocio abierto con esta marca? Entonces la señal es
  // contexto de ese negocio, no un negocio más: el tercero de Vitalé
  // abierto «sin avisar» era justo lo que el CRM tiene que evitar.
  const abierto = await tx.query<{ id: string }>(
    `SELECT d.id
       FROM deal d
       JOIN pipeline_stage st ON st.id = d.stage_id
      WHERE d.company_id = $1 AND NOT st.is_won AND NOT st.is_lost
      ORDER BY st.position DESC, d.created_at DESC
      LIMIT 1`,
    [companyId],
  );
  const existente = abierto.rows[0]?.id;
  if (existente) {
    await tx.query(
      `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, body, metadata)
       VALUES (current_workspace_id(), $1, $2, current_user_id(), 'signal_detected', $3, $4, $5::jsonb)`,
      [companyId, existente, truncate(sig.headline_es, 200), opts.activityBody ?? null, metadata],
    );
    await markAccepted();
    return { dealId: existente, companyId, companyName: company.name, companyCreated, dealCreated: false };
  }

  const dealName = dealNameFromSignal(sig.headline_es, ev, [company.name, evName], opts.pendingDealName);
  // Quien acepta la señal es el responsable del negocio y de su «Enviar
  // pitch» (VEN-4: cada negocio abierto tiene acción, fecha y responsable),
  // como company_link lo toma de responsable de la empresa. Sin sesión (la
  // demo), current_user_id() es NULL y queda sin responsable, como antes.
  // De qué creador es (ACC-7): el único del espacio o del alcance de
  // quien acepta. Una señal no dice de quién es; quien lleva a varios
  // creadores y está acotado abre el negocio desde la ficha, eligiendo.
  const creatorId = await creatorForNewDeal(tx, null);
  const deal = await tx.query<{ id: string }>(
    `INSERT INTO deal (workspace_id, company_id, origin_signal_id, owner_user_id, name, stage_id, amount, currency,
                       next_action, next_action_kind, next_action_due, next_action_user_id, creator_id)
     SELECT current_workspace_id(), $1, $2, current_user_id(), $3, 'nuevo', $4::numeric, w.currency, $5, 'pitch',
            ${dueInBusinessDays('$8', '$6', '$7')}, current_user_id(), $9::uuid
     FROM ${WORKSPACE_TZ} w
     RETURNING id`,
    [
      companyId, signalId, truncate(dealName, 120), sig.budget_estimate, opts.nextAction?.trim() || PITCH_ACTION,
      PITCH_DUE_BUSINESS_DAYS, PITCH_DUE_HOUR, opts.now?.toISOString() ?? null, creatorId,
    ],
  );
  const dealId = deal.rows[0]?.id;
  if (!dealId) throw new VentasError('DealCreateFailed');

  await tx.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by)
     VALUES ($1, NULL, 'nuevo', current_user_id())`,
    [dealId],
  );
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, body, metadata)
     VALUES (current_workspace_id(), $1, $2, current_user_id(), 'signal_detected', $3, $4, $5::jsonb)`,
    [companyId, dealId, truncate(sig.headline_es, 200), opts.activityBody ?? null, metadata],
  );
  await markAccepted();

  return { dealId, companyId, companyName: company.name, companyCreated, dealCreated: true };
}

/** Lo que pasó al no aceptar la marca de una señal (rejectSignalBrand). */
export interface RejectSignalBrandResult {
  companyId: string;
  companyName: string;
  /** La marca no estaba en el CRM y nació aquí (relación 'blocked'). */
  companyCreated: boolean;
  /** A cuántos briefs activos se agregó, y cuántos se miraron. */
  added: number;
  briefs: number;
  /** Después de excluirla, la señal ya no se ve en la bandeja (la excluyen todos los briefs activos). */
  hidden: boolean;
}

/**
 * «No aceptar esta marca», desde su tarjeta en el radar (VEN-7 r4).
 *
 * Una marca que llega por el catálogo o por una señal automática no se
 * podía excluir por nombre sin darla antes de alta en el CRM: el brief
 * solo guarda empresas del CRM (saveBrief, CompanyNotInCrm). Aquí, en la
 * MISMA transacción:
 *
 *   1. se resuelve la empresa de la señal como al aceptarla
 *      (companyOfSignal): la conocida o una nueva con lo que trae;
 *   2. se enlaza al CRM con la relación 'blocked' si no estaba (si ya
 *      estaba, su relación no se toca: un cliente sigue siendo cliente);
 *   3. se agrega a «Marcas que no aceptas» de los briefs activos de los
 *      creadores pedidos, o de todos (addExcludedCompany: permiso, tope,
 *      candado y traza).
 *
 * La señal sigue pendiente: si ahora la excluyen todos los briefs
 * activos, la bandeja la oculta como a cualquier otra (`hidden`); si
 * otro creador la acepta, se sigue viendo y el resultado lo dice.
 */
export async function rejectSignalBrand(
  tx: WorkspaceTx,
  signalId: string,
  opts: { creatorIds?: readonly string[] } = {},
): Promise<RejectSignalBrandResult> {
  if (!isUuid(signalId)) throw new BriefError('SignalNotFound');
  const { rows } = await tx.query<{ id: string; company_id: string | null; status: SignalStatus; evidence: Record<string, unknown> | null }>(
    'SELECT id, company_id, status, evidence FROM signal WHERE id = $1 FOR UPDATE',
    [signalId],
  );
  const sig = rows[0];
  if (!sig || sig.status !== 'pending') throw new BriefError('SignalNotFound');

  const resuelta = await companyOfSignal(tx, sig);
  if (!resuelta) throw new BriefError('SignalWithoutBrand');
  const { company, created } = resuelta;
  await linkBlocked(tx, company.id);
  const { added, briefs } = await addExcludedCompany(tx, company.id, opts);
  const { rows: v } = await tx.query<{ verdict: string | null }>(
    `SELECT ${briefVerdictSql('s')} AS verdict FROM signal s WHERE s.id = $1`,
    [signalId],
  );
  return { companyId: company.id, companyName: company.name, companyCreated: created, added, briefs, hidden: (v[0]?.verdict ?? null) !== null };
}

/** Lo que pasó al no aceptar una marca por su nombre, desde el brief (rejectBrandByName). */
export interface RejectBrandByNameResult {
  id: string;
  name: string;
  /** La marca no existía y nació aquí. */
  created: boolean;
  /** La relación que tenía en el CRM antes; null si no estaba (ahora es 'blocked'). */
  previousRelationship: string | null;
}

/**
 * «No aceptar «…»», desde «Marcas que no aceptas» del brief (VEN-7 r5):
 * una marca que el creador no acepta y que todavía no está en el CRM —la
 * competencia de un cliente, como en el formulario de preferencias de
 * Passionfroot— se da de alta por su nombre (y su dominio, si lo hay)
 * para poder excluirla por adelantado, sin esperar a que llegue una
 * señal suya al radar.
 *
 * Es la misma alta que la de rejectSignalBrand, sin la señal:
 *   1. la marca conocida por dominio o, sin dominio, por nombre en el CRM
 *      (findOrCreateCompany), o una nueva;
 *   2. enlazada al CRM como 'blocked' si no estaba (linkBlocked: si ya
 *      estaba, su relación no se toca).
 *
 * No toca el brief: la pantalla la agrega como etiqueta y viaja al
 * guardar (saveBrief, con su propia traza). Desde ese momento una señal
 * con ese nombre o ese dominio queda oculta, como cualquier marca
 * excluida (briefVerdictSql la reconoce por nombre dentro del CRM).
 *
 * Mismo permiso que el brief: solo owner y admin (outreach_can_manage,
 * la regla de 0073 §5); si no, Forbidden y no queda nada. Deja traza en
 * audit_log ('ventas.brief.no_aceptar_marca', la relación antes y después).
 */
export async function rejectBrandByName(
  tx: WorkspaceTx,
  input: { name: string; domain?: string | null },
): Promise<RejectBrandByNameResult> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name || name.length > BRIEF_LIMITS.brandNameMax || !nameKey(name)) throw new BriefError('InvalidBrandName');
  const { rows: permiso } = await tx.query<{ ok: boolean }>('SELECT outreach_can_manage(current_workspace_id()) AS ok');
  if (!permiso[0]?.ok) throw new BriefError('Forbidden');

  const resuelta = await findOrCreateCompany(tx, { name, domain: input.domain ?? null });
  if (!resuelta) throw new BriefError('InvalidBrandName');
  const { company, created } = resuelta;
  const previa = await linkBlocked(tx, company.id);
  await tx.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
     VALUES (current_workspace_id(), current_user_id(), 'user', 'ventas.brief.no_aceptar_marca', 'company', $1::uuid, $2::jsonb, $3::jsonb)`,
    [
      company.id,
      JSON.stringify(previa ? { relationship: previa } : null),
      JSON.stringify({ name: company.name, domain: company.domain, relationship: previa ?? 'blocked', created }),
    ],
  );
  return { id: company.id, name: company.name, created, previousRelationship: previa };
}

export interface CreateDealInput {
  companyId: string;
  /** Cómo llama la creadora a este trabajo: «Serie de 3 videos Q4». */
  name: string;
  /** Monto estimado, string decimal sin impuesto; vacío si aún no se sabe. */
  amount?: string | null;
  /** La siguiente acción, en el idioma de la pantalla. Por defecto, PITCH_ACTION. */
  nextAction?: string;
  /** Desde cuándo se cuentan los días hábiles del pitch. Por defecto, now() de la base; lo fijan las pruebas. */
  now?: Date;
  /**
   * De qué creador es (ACC-7). Sin él, el único del espacio o del alcance
   * de quien lo abre (creatorForNewDeal); con varios, lo elige la ficha
   * (listDealCreatorOptions).
   */
  creatorId?: string | null;
}

/** Un creador que se puede elegir para un negocio. */
export interface DealCreatorOption {
  id: string;
  name: string;
}

/** Los creadores para «Nuevo negocio» y para cambiar el de un negocio, y si elegir uno es obligatorio. */
export interface DealCreatorOptions {
  creators: DealCreatorOption[];
  /**
   * Quien está acotado por creador tiene que elegir cuando no lleva
   * exactamente uno: un negocio sin creador quedaría fuera de su alcance
   * y no lo vería (ACC-6 D4). Quien ve a todos puede dejarlo «Sin
   * creador», como hasta hoy. Con un solo creador no se pregunta: es
   * ese. Acotado y sin ninguno (su alcance apunta a creadores dados de
   * baja), es obligatorio y no hay a quién: no puede abrir negocios.
   */
  required: boolean;
  /** `session_sees_all_creators()`: si puede dejar o pasar un negocio a «Sin creador». */
  seesAll: boolean;
}

/**
 * Los creadores vivos que la persona de la transacción puede poner en un
 * negocio, ordenados por nombre, y si ve a todos. Es LA lectura del
 * selector de la ficha y de las altas (creatorForNewDeal, setDealCreator):
 * los dos cuentan de `creators_for_session()` (0082 §1b), la misma lista
 * que usa el worker al abrir el negocio de una respuesta. Un alcance a
 * un creador dado de baja no aparece. «Ve a todos» se pregunta en su
 * propia consulta, no se deduce de la primera fila: sin creadores no hay
 * filas.
 */
export async function listDealCreatorOptions(tx: WorkspaceTx): Promise<DealCreatorOptions> {
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT cp.id, cp.display_name AS name
       FROM creators_for_session(current_workspace_id()) AS e(id)
       JOIN creator_profile cp ON cp.id = e.id
      ORDER BY lower(cp.display_name), cp.id`,
  );
  const todos = await tx.query<{ all: boolean }>('SELECT session_sees_all_creators() AS all');
  // Sin respuesta, acotada: cerrado, nunca abierto.
  const seesAll = todos.rows[0]?.all === true;
  const creators = rows.map((r) => ({ id: r.id, name: r.name }));
  return { creators, required: !seesAll && creators.length !== 1, seesAll };
}

/**
 * Un creador elegido a mano para un negocio: tiene que ser un creador
 * vivo del espacio (InvalidCreator) y estar entre los que la persona
 * puede poner (ScopeError). La misma lista que el selector.
 */
async function assertChosenCreator(tx: WorkspaceTx, chosen: string): Promise<{ name: string }> {
  if (!isUuid(chosen)) throw new VentasError('InvalidCreator');
  const { rows } = await tx.query<{ ok: boolean; name: string }>(
    `SELECT EXISTS (SELECT 1 FROM creators_for_session(current_workspace_id()) AS e(id) WHERE e.id = cp.id) AS ok,
            cp.display_name AS name
       FROM creator_profile cp WHERE cp.id = $1 AND cp.deleted_at IS NULL`,
    [chosen],
  );
  const row = rows[0];
  if (!row) throw new VentasError('InvalidCreator');
  if (row.ok !== true) throw new ScopeError();
  return { name: row.name };
}

/**
 * El creador de un negocio que se va a abrir (ACC-7). La política por
 * creador de deal (0082 §3) no deja escribir una fila fuera del alcance
 * de quien la escribe; aquí se decide ANTES, para decirlo en el idioma
 * de la pantalla y no con un 42501:
 *
 *   · si llega uno elegido, assertChosenCreator (InvalidCreator,
 *     ScopeError);
 *   · si no, el único de listDealCreatorOptions; con varios, NULL para
 *     quien ve a todos («sin creador», como hasta hoy) y
 *     DealCreatorRequired para quien está acotado; acotado y sin
 *     ninguno, NoCreatorInScope.
 */
export async function creatorForNewDeal(tx: WorkspaceTx, chosen: string | null | undefined): Promise<string | null> {
  if (chosen) {
    await assertChosenCreator(tx, chosen);
    return chosen;
  }
  const { creators, seesAll } = await listDealCreatorOptions(tx);
  if (creators.length === 1) return creators[0]!.id;
  if (seesAll) return null;
  throw new VentasError(creators.length === 0 ? 'NoCreatorInScope' : 'DealCreatorRequired');
}

/**
 * Cambia de qué creador es un negocio (ACC-7, hallazgo 6 de la ronda 2):
 * hasta ahora solo se elegía al abrirlo, y un negocio «Sin creador» o
 * del creador equivocado no tenía arreglo desde la pantalla.
 *
 *   · `creatorId` elegido: assertChosenCreator, como al abrirlo;
 *   · `null` («Sin creador»): solo quien ve a todos. A quien está acotado
 *     el negocio se le iría de las manos (ScopeError);
 *   · y nunca a un creador distinto del de su cotización enviada o su
 *     campaña viva (DealCreatorLocked, deal_creator_locked de 0082 §7):
 *     el negocio, la cotización y la campaña de un mismo acuerdo son del
 *     mismo creador, o el pipeline y Campañas se contradicen para quien
 *     está acotado. Pasar AL creador de la cotización sí se deja.
 *
 * El negocio tiene que verse (si no, DealNotFound: el de otro creador no
 * existe para quien está acotado). Deja su fila en audit_log
 * ('deal.creator_changed', el creador antes y después). Devuelve si
 * cambió algo y el nombre del creador elegido (null: «Sin creador»).
 */
export async function setDealCreator(
  tx: WorkspaceTx,
  dealId: string,
  creatorId: string | null,
): Promise<{ changed: boolean; creatorName: string | null }> {
  if (!isUuid(dealId)) throw new DealNotFound();
  const antes = (await tx.query<{ creator_id: string | null }>('SELECT creator_id FROM deal WHERE id = $1 FOR UPDATE', [dealId])).rows[0];
  if (!antes) throw new DealNotFound();
  let creatorName: string | null = null;
  if (creatorId) {
    creatorName = (await assertChosenCreator(tx, creatorId)).name;
  } else {
    const todos = await tx.query<{ all: boolean }>('SELECT session_sees_all_creators() AS all');
    if (todos.rows[0]?.all !== true) throw new ScopeError();
  }
  if (antes.creator_id === creatorId) return { changed: false, creatorName };
  // El acuerdo no se parte entre dos creadores: con una cotización enviada
  // o una campaña viva de otro creador, el negocio sigue con el suyo
  // (deal_creator_locked, 0082 §7; también ve la campaña que la política
  // esconde a quien está acotado).
  const locked = await tx.query<{ v: boolean }>('SELECT deal_creator_locked($1::uuid, $2::uuid) AS v', [dealId, creatorId]);
  if (locked.rows[0]?.v !== false) throw new VentasError('DealCreatorLocked');
  const { rows } = await tx.query<{ id: string }>('UPDATE deal SET creator_id = $2::uuid WHERE id = $1 RETURNING id', [dealId, creatorId]);
  if (!rows[0]) throw new DealNotFound();
  await audit(tx, {
    action: 'deal.creator_changed',
    entityType: 'deal',
    entityId: dealId,
    before: { creatorId: antes.creator_id },
    after: { creatorId },
  });
  return { changed: true, creatorName };
}

/**
 * ¿Esta marca tiene un negocio abierto que la persona no ve por su
 * alcance por creador? Sí o no, sin decir cuál ni cuántos
 * (open_deal_out_of_scope, 0082 §6). Para que la ficha explique la
 * ausencia en vez de enseñar un pipeline incompleto sin decirlo. Falso
 * para quien ve a todos.
 */
export async function hasOpenDealOutOfScope(tx: WorkspaceTx, companyId: string): Promise<boolean> {
  if (!isUuid(companyId)) return false;
  const { rows } = await tx.query<{ v: boolean }>('SELECT open_deal_out_of_scope($1::uuid) AS v', [companyId]);
  return rows[0]?.v === true;
}

/**
 * Abrir un negocio a mano desde la ficha de una empresa de MI CRM.
 *
 * Nace en «nuevo», en la moneda del workspace, con su primera fila de
 * historial y la siguiente acción a tres días hábiles a las 15:00 locales, como
 * uno que llega del radar. Quien lo abre es su responsable y el de esa
 * primera acción (VEN-4). Que la empresa ya tenga otro abierto no lo
 * impide: aquí lo pide la persona, a propósito (otra campaña, otro
 * producto de la misma marca).
 */
export async function createDeal(tx: WorkspaceTx, input: CreateDealInput): Promise<string> {
  if (!isUuid(input.companyId)) throw new CompanyNotFound();
  const name = input.name.trim();
  if (!name || name.length > 120) throw new VentasError('InvalidDealName');
  const amount = input.amount?.trim() || null;
  if (amount !== null && !/^\d{1,12}(\.\d{1,2})?$/.test(amount)) throw new VentasError('InvalidAmount');

  const linked = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1', [input.companyId]);
  if (linked.rows.length === 0) throw new CompanyNotFound();

  const creatorId = await creatorForNewDeal(tx, input.creatorId);
  const deal = await tx.query<{ id: string }>(
    `INSERT INTO deal (workspace_id, company_id, owner_user_id, name, stage_id, amount, currency,
                       next_action, next_action_kind, next_action_due, next_action_user_id, creator_id)
     SELECT current_workspace_id(), $1, current_user_id(), $2, 'nuevo', $3::numeric, w.currency, $4, 'pitch',
            ${dueInBusinessDays('$7', '$5', '$6')}, current_user_id(), $8::uuid
     FROM ${WORKSPACE_TZ} w
     RETURNING id`,
    [
      input.companyId, name, amount, input.nextAction?.trim() || PITCH_ACTION, PITCH_DUE_BUSINESS_DAYS, PITCH_DUE_HOUR,
      input.now?.toISOString() ?? null, creatorId,
    ],
  );
  const dealId = deal.rows[0]?.id;
  if (!dealId) throw new VentasError('DealCreateFailed');
  await tx.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by)
     VALUES ($1, NULL, 'nuevo', current_user_id())`,
    [dealId],
  );
  return dealId;
}

/**
 * Descartar una señal con su motivo. No se borra: se marca, y su
 * dedupe_key sigue ocupando el UNIQUE, que es lo que impide que la
 * misma vuelva a la bandeja mañana.
 */
export async function discardSignal(tx: WorkspaceTx, signalId: string, reason: string): Promise<void> {
  if (!isUuid(signalId)) throw new SignalNotFound();
  const motivo = reason.trim();
  if (!motivo) throw new VentasError('InvalidReason');
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE signal
     SET status = 'discarded', discard_reason = $2, reviewed_by = current_user_id(), reviewed_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [signalId, truncate(motivo, 280)],
  );
  if (rows.length === 0) {
    const exists = await tx.query('SELECT 1 FROM signal WHERE id = $1', [signalId]);
    throw exists.rows.length > 0 ? new SignalAlreadyReviewed() : new SignalNotFound();
  }
}
