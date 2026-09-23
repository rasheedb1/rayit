/**
 * Consultas del módulo Ventas: empresas y contactos (VEN-1), el radar
 * de señales (VEN-2) y el pipeline (VEN-3). Dueño: Rasheed.
 *
 * Reglas que no cambian (las mismas de queries/finanzas.ts):
 *   - Toda función recibe un WorkspaceTx: una transacción con el
 *     workspace ya fijado. Ninguna recibe un workspace_id suelto. Las
 *     lecturas las filtra RLS; los INSERT escriben
 *     `current_workspace_id()`, nunca un valor que venga de la pantalla.
 *   - El dinero entra y sale como string decimal. Postgres devuelve
 *     numeric como texto y aquí no se convierte a number nunca.
 *   - Ningún número derivado se calcula en React: lo que la pantalla
 *     muestra ya viene sumado, contado o ponderado desde SQL (los KPI
 *     salen de getSalesKpis, el pipeline de la vista deal_pipeline).
 *   - Un id que llega de fuera se valida con `isUuid` antes de
 *     consultar; una búsqueda por id devuelve `null` cuando el id es
 *     imposible, igual que cuando no existe.
 *
 * Sobre el aislamiento de esta parte del esquema, que no es uniforme y
 * es fácil de leer mal (migraciones 0020, 0024, 0025 y 0026):
 *   - `company` tiene dueño (`owner_workspace_id`, que pone la base) y
 *     se lee «sin dueño o mía»: la empresa de otro workspace no se ve
 *     ni se nombra. Las filas sin dueño son el catálogo compartido: se
 *     leen, se vinculan, y no se editan desde aquí. Que una empresa esté
 *     en MI CRM lo sigue diciendo `company_link`, y por eso cada lectura
 *     de empresas entra por company_link con un JOIN: el catálogo solo
 *     no es mi lista.
 *   - `contact` lleva PII y su candado es `owner_workspace_id`, que pone
 *     la base sola (DEFAULT current_workspace_id()). Aquí NO se escribe
 *     a mano en ningún INSERT: si apareciera en una lista de columnas
 *     sería un error, no una optimización. El correo es único POR
 *     DUEÑO: que otro workspace tenga a la misma persona no impide
 *     guardarla, y la baja global la aplica la base (contact_suppression,
 *     que solo llena el worker con una baja verificada: la que marca
 *     un workspace se queda en su contacto, 0029 §1).
 *   - `opted_out` no vuelve a false: un trigger lo impide. La pantalla
 *     lo muestra como estado inamovible y esta capa no ofrece la
 *     operación contraria.
 */
import { isUuid, type WorkspaceTx } from '../client.ts';
import { CONTACT_SOURCES, RELATIONSHIPS, SIGNAL_STATUSES } from '../schema/ventas.ts';

export { CONTACT_SOURCES, RELATIONSHIPS, SIGNAL_STATUSES };

/** Procedencia de un contacto. Sin ella no se guarda (VEN-1). */
export type ContactSource = (typeof CONTACT_SOURCES)[number];
/** Relación del workspace con la empresa (company_link). */
export type Relationship = (typeof RELATIONSHIPS)[number];

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

/** Base de los errores de Ventas: el mensaje ya está en español. */
export class VentasError extends Error {
  readonly code: string;
  constructor(code: string, messageEs: string) {
    super(messageEs);
    this.name = code;
    this.code = code;
  }
  /** El mismo texto que `message`, con nombre explícito para las pantallas. */
  get messageEs(): string {
    return this.message;
  }
}

export class CompanyNotFound extends VentasError {
  constructor() {
    super('CompanyNotFound', 'Esa empresa no existe en tu espacio.');
  }
}

/**
 * Editar el nombre, el dominio o la ficha de una empresa del catálogo
 * compartido (sin dueño). Se puede vincular y trabajar con ella —su
 * relación y sus notas son de este workspace—, pero sus datos son de
 * todos y solo los escribe el worker (0024 §4, company_write).
 */
export class CompanyNotEditable extends VentasError {
  constructor() {
    super(
      'CompanyNotEditable',
      'Esta empresa es del catálogo compartido: sus datos no se editan desde tu espacio. Puedes cambiar la relación y las notas.',
    );
  }
}

export class ContactNotFound extends VentasError {
  constructor() {
    super('ContactNotFound', 'Ese contacto no existe o no lo guardaste tú.');
  }
}

export class SignalNotFound extends VentasError {
  constructor() {
    super('SignalNotFound', 'Esa señal ya no está en tu bandeja.');
  }
}

export class DealNotFound extends VentasError {
  constructor() {
    super('DealNotFound', 'Ese negocio no existe en tu espacio.');
  }
}

export class SignalAlreadyReviewed extends VentasError {
  constructor() {
    super('SignalAlreadyReviewed', 'Esa señal ya la revisaste. Recarga la bandeja para ver cómo quedó.');
  }
}

export class DuplicateDomain extends VentasError {
  constructor(name: string) {
    super('DuplicateDomain', `Ese dominio ya es de «${name}». Búscala en vez de crearla otra vez.`);
  }
}

/**
 * Escribir un contacto ajeno. La política de 0020 no distingue «no
 * existe» de «no es tuyo» a propósito (decir cuál sería filtrar la
 * existencia de la fila), así que el mensaje tampoco.
 */
export class ContactNotOwned extends VentasError {
  constructor() {
    super('ContactNotOwned', 'Solo puedes editar los contactos que guardaste tú.');
  }
}

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

export interface CompanyListRow {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  nicheSlugs: string[];
  sizeBucket: string | null;
  relationship: Relationship;
  /** 0..1 como string decimal, o null. */
  fitScore: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  notes: string | null;
  /** Contactos visibles de la empresa (los míos y los de fuente pública). */
  contactCount: number;
  /** De esos, cuántos pidieron la baja. */
  optedOutCount: number;
  /** Negocios ni ganados ni perdidos. */
  openDealCount: number;
  /** Suma de los abiertos, en la moneda del workspace, como string decimal. */
  openDealAmount: string;
  /** Última actividad registrada para la empresa, ISO o null. */
  lastActivityAt: string | null;
  /** Señales pendientes de revisar de esta empresa. */
  pendingSignalCount: number;
  linkedAt: string;
}

export interface CompanyDetail extends CompanyListRow {
  legalName: string | null;
  socials: Record<string, string>;
  runsAds: boolean | null;
  adsPlatforms: string[];
  logoUrl: string | null;
  enrichedAt: string | null;
}

export interface ContactRow {
  id: string;
  companyId: string;
  fullName: string | null;
  roleTitle: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  instagramHandle: string | null;
  source: ContactSource;
  sourceUrl: string | null;
  optedOut: boolean;
  optedOutAt: string | null;
  optedOutReason: string | null;
  bounced: boolean;
  /**
   * Lo guardó este workspace. Un contacto visible pero ajeno (fuente
   * pública, guardado por otro) se lee y no se edita: la pantalla lo
   * muestra sin los botones, y la base lo rechazaría igual.
   */
  isOwn: boolean;
  createdAt: string;
}

export interface SignalRow {
  id: string;
  companyId: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** La empresa ya está vinculada a este workspace. */
  companyLinked: boolean;
  sourceId: string;
  sourceLabel: string;
  headlineEs: string;
  detectedAt: string;
  evidenceUrl: string | null;
  fitScore: string | null;
  budgetEstimate: string | null;
  budgetCurrency: string | null;
  dedupeKey: string;
  status: SignalStatus;
  discardReason: string | null;
  reviewedAt: string | null;
  /** 'csv' si entró por una lista importada; 'manual' si la escribió alguien. */
  via: SignalVia;
}

export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export interface PipelineDealRow {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  stageId: string;
  stageLabel: string;
  stagePosition: number;
  amount: string | null;
  currency: string;
  probability: string;
  weightedAmount: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  dueState: DueState;
  lastContactAt: string | null;
  expectedCloseDate: string | null;
  isWon: boolean;
  isLost: boolean;
  /** Días en la etapa actual: desde el último cambio, o desde que nació. */
  daysInStage: number;
  ownerName: string | null;
}

export type DueState = 'sin_fecha' | 'vencido' | 'hoy' | 'futuro';

export interface SalesKpis {
  /** Señales en la bandeja. */
  pendingSignals: number;
  openDeals: number;
  /** Suma de los abiertos, string decimal. */
  openAmount: string;
  /** Suma de amount × probabilidad de los abiertos, string decimal. */
  weightedAmount: string;
  /** Ganados en el trimestre en curso (won_at). */
  wonQuarter: string;
  wonQuarterCount: number;
  /** Abiertos sin siguiente acción: la fila que hay que arreglar. */
  noNextActionCount: number;
  /** Abiertos con la siguiente acción vencida. */
  overdueCount: number;
  /** La del workspace: los KPI suman sin convertir, así que todo va en ella. */
  currency: string;
}

// ---------------------------------------------------------------------
// Listas auxiliares
// ---------------------------------------------------------------------

/** Longitud mínima de una búsqueda por nombre. Debajo de esto no se consulta. */
export const MIN_SEARCH = 3;

/** Un `limit` que llega de la URL, acotado a un rango sensato. */
function safeLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** Texto de búsqueda listo para el trigram, o null si no llega al mínimo. */
export function searchTerm(raw: string | undefined | null): string | null {
  const q = (raw ?? '').trim();
  return q.length >= MIN_SEARCH ? q : null;
}

// ---------------------------------------------------------------------
// VEN-1 · Empresas
// ---------------------------------------------------------------------

export interface ListCompaniesParams {
  /** Nombre o dominio. Se ignora con menos de tres caracteres. */
  search?: string | null;
  relationship?: Relationship | null;
  /** 1..200. Por defecto 50. */
  limit?: number;
}

/**
 * Las empresas de este workspace, con lo que la lista necesita ya
 * contado: contactos, negocios abiertos y su suma, señales pendientes y
 * última actividad. Entra por company_link (aislada), no por company
 * (catálogo global).
 *
 * La búsqueda usa el índice trigram de `company (name gin_trgm_ops)`
 * que existe desde la migración 0007, y añade el dominio por si se pega
 * una URL. `%` y `_` del usuario se escapan: sin eso un `%` solo
 * devolvería todo y parecería que el filtro no sirve.
 */
export async function listCompanies(tx: WorkspaceTx, params: ListCompaniesParams = {}): Promise<CompanyListRow[]> {
  const q = searchTerm(params.search);
  const limit = safeLimit(params.limit, 50, 200);
  const relationship = params.relationship && RELATIONSHIPS.includes(params.relationship) ? params.relationship : null;

  const { rows } = await tx.query<CompanyRowSql>(
    `
    SELECT co.id,
           co.name,
           co.domain::text                       AS domain,
           co.country::text                      AS country,
           co.city,
           co.industry,
           co.niche_slugs                        AS niche_slugs,
           co.size_bucket,
           cl.relationship,
           cl.fit_score::text                    AS fit_score,
           cl.owner_user_id,
           u.name                                AS owner_name,
           cl.notes,
           cl.created_at                         AS linked_at,
           ${CONTACT_COUNTS},
           ${DEAL_COUNTS},
           ${PENDING_SIGNALS},
           ${LAST_ACTIVITY}
    FROM company_link cl
    JOIN company co       ON co.id = cl.company_id
    LEFT JOIN app_user u  ON u.id = cl.owner_user_id
    WHERE ($1::text IS NULL OR co.name ILIKE '%' || ${ESCAPE_LIKE} || '%'
                            OR co.domain ILIKE '%' || ${ESCAPE_LIKE} || '%')
      AND ($2::text IS NULL OR cl.relationship = $2)
    ORDER BY ${q ? `similarity(co.name, $1) DESC,` : ''} co.name ASC
    LIMIT $3
    `,
    [q, relationship, limit],
  );
  return rows.map(toCompanyRow);
}

/** Una empresa de este workspace por su id, o null si no es suya (o el id es imposible). */
export async function getCompany(tx: WorkspaceTx, companyId: string): Promise<CompanyDetail | null> {
  if (!isUuid(companyId)) return null;
  const { rows } = await tx.query<CompanyRowSql & CompanyDetailSql>(
    `
    SELECT co.id,
           co.name,
           co.legal_name,
           co.domain::text                       AS domain,
           co.country::text                      AS country,
           co.city,
           co.industry,
           co.niche_slugs                        AS niche_slugs,
           co.size_bucket,
           co.socials,
           co.runs_ads,
           co.ads_platforms,
           co.logo_url,
           co.enriched_at,
           cl.relationship,
           cl.fit_score::text                    AS fit_score,
           cl.owner_user_id,
           u.name                                AS owner_name,
           cl.notes,
           cl.created_at                         AS linked_at,
           ${CONTACT_COUNTS},
           ${DEAL_COUNTS},
           ${PENDING_SIGNALS},
           ${LAST_ACTIVITY}
    FROM company_link cl
    JOIN company co       ON co.id = cl.company_id
    LEFT JOIN app_user u  ON u.id = cl.owner_user_id
    WHERE cl.company_id = $1
    LIMIT 1
    `,
    [companyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...toCompanyRow(row),
    legalName: row.legal_name,
    socials: (row.socials ?? {}) as Record<string, string>,
    runsAds: row.runs_ads,
    adsPlatforms: row.ads_platforms ?? [],
    logoUrl: row.logo_url,
    enrichedAt: row.enriched_at,
  };
}

export interface CreateCompanyInput {
  name: string;
  domain?: string | null;
  country?: string | null;
  city?: string | null;
  industry?: string | null;
  nicheSlugs?: string[];
  sizeBucket?: string | null;
  relationship?: Relationship;
  notes?: string | null;
  ownerUserId?: string | null;
}

/**
 * Crea la empresa y la vincula a este workspace.
 *
 * `company` es un catálogo global: si el dominio ya existe, la empresa
 * NO se duplica —se reutiliza la fila y se vincula—. Eso es lo correcto
 * para el catálogo y lo que evita dos «Café Alma» con la misma web;
 * pero si ya está vinculada a este workspace, se avisa, porque quien la
 * está creando no la encontró y probablemente escribió mal el nombre.
 */
export async function createCompany(tx: WorkspaceTx, input: CreateCompanyInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new VentasError('InvalidName', 'La empresa necesita un nombre.');
  const domain = normalizeDomain(input.domain);
  const relationship = input.relationship && RELATIONSHIPS.includes(input.relationship) ? input.relationship : 'prospect';
  if (input.ownerUserId && !isUuid(input.ownerUserId)) {
    throw new VentasError('InvalidOwner', 'El responsable no es válido.');
  }

  let companyId: string | undefined;
  if (domain) {
    const existing = await tx.query<{ id: string; name: string }>(
      'SELECT id, name FROM company WHERE domain = $1 LIMIT 1',
      [domain],
    );
    const found = existing.rows[0];
    if (found) {
      const linked = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1', [found.id]);
      if (linked.rows.length > 0) throw new DuplicateDomain(found.name);
      companyId = found.id;
    }
  }

  if (!companyId) {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO company (name, domain, country, city, industry, niche_slugs, size_bucket)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::text[], '{}'), $7)
       RETURNING id`,
      [
        name,
        domain,
        normalizeCountry(input.country),
        input.city?.trim() || null,
        input.industry?.trim() || null,
        input.nicheSlugs?.length ? input.nicheSlugs : null,
        input.sizeBucket || null,
      ],
    );
    companyId = inserted.rows[0]?.id;
    if (!companyId) throw new VentasError('CreateFailed', 'No se pudo crear la empresa.');
  }

  await tx.query(
    `INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, notes)
     VALUES (current_workspace_id(), $1, $2, $3, $4)
     ON CONFLICT (workspace_id, company_id) DO NOTHING`,
    [companyId, input.ownerUserId ?? null, relationship, input.notes?.trim() || null],
  );
  return companyId;
}

export interface UpdateCompanyInput extends Partial<CreateCompanyInput> {}

/**
 * Edita la empresa y su relación con este workspace.
 *
 * La ficha (nombre, dominio, ciudad…) se toca solo si la empresa está
 * vinculada aquí y es de este workspace. La base ya lo impone
 * (company_write: solo el dueño), pero un UPDATE que la política filtra
 * no falla: toca cero filas y la pantalla diría «guardado». Por eso,
 * sobre una empresa del catálogo compartido, CompanyNotEditable.
 */
export async function updateCompany(tx: WorkspaceTx, companyId: string, input: UpdateCompanyInput): Promise<void> {
  if (!isUuid(companyId)) throw new CompanyNotFound();
  const linked = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1', [companyId]);
  if (linked.rows.length === 0) throw new CompanyNotFound();

  if (input.name !== undefined && !input.name.trim()) {
    throw new VentasError('InvalidName', 'La empresa necesita un nombre.');
  }
  const domain = input.domain === undefined ? undefined : normalizeDomain(input.domain);
  if (domain) {
    const clash = await tx.query<{ name: string }>(
      'SELECT name FROM company WHERE domain = $1 AND id <> $2 LIMIT 1',
      [domain, companyId],
    );
    const other = clash.rows[0];
    if (other) throw new DuplicateDomain(other.name);
  }

  const tocaFicha = [
    input.name, input.domain, input.country, input.city, input.industry, input.nicheSlugs, input.sizeBucket,
  ].some((v) => v !== undefined);
  if (!tocaFicha) {
    await updateCompanyLink(tx, companyId, input);
    return;
  }

  const { rows: editadas } = await tx.query<{ id: string }>(
    `UPDATE company SET
       name        = COALESCE($2, name),
       domain      = CASE WHEN $3::boolean THEN $4::citext ELSE domain END,
       country     = COALESCE($5, country),
       city        = CASE WHEN $6::boolean THEN $7 ELSE city END,
       industry    = CASE WHEN $8::boolean THEN $9 ELSE industry END,
       niche_slugs = COALESCE($10::text[], niche_slugs),
       size_bucket = CASE WHEN $11::boolean THEN $12 ELSE size_bucket END,
       updated_at  = now()
     WHERE id = $1
     RETURNING id`,
    [
      companyId,
      input.name?.trim() ?? null,
      domain !== undefined, domain ?? null,
      normalizeCountry(input.country),
      input.city !== undefined, input.city?.trim() || null,
      input.industry !== undefined, input.industry?.trim() || null,
      input.nicheSlugs ?? null,
      input.sizeBucket !== undefined, input.sizeBucket || null,
    ],
  );
  if (editadas.length === 0) throw new CompanyNotEditable();

  await updateCompanyLink(tx, companyId, input);
}

/** La relación de este workspace con la empresa: su company_link. */
async function updateCompanyLink(tx: WorkspaceTx, companyId: string, input: UpdateCompanyInput): Promise<void> {
  if (input.relationship !== undefined || input.notes !== undefined || input.ownerUserId !== undefined) {
    if (input.relationship !== undefined && !RELATIONSHIPS.includes(input.relationship)) {
      throw new VentasError('InvalidRelationship', 'Esa relación no existe.');
    }
    if (input.ownerUserId && !isUuid(input.ownerUserId)) {
      throw new VentasError('InvalidOwner', 'El responsable no es válido.');
    }
    await tx.query(
      `UPDATE company_link SET
         relationship  = COALESCE($2, relationship),
         notes         = CASE WHEN $3::boolean THEN $4 ELSE notes END,
         owner_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_user_id END,
         updated_at    = now()
       WHERE company_id = $1`,
      [
        companyId,
        input.relationship ?? null,
        input.notes !== undefined, input.notes?.trim() || null,
        input.ownerUserId !== undefined, input.ownerUserId ?? null,
      ],
    );
  }
}

// ---------------------------------------------------------------------
// VEN-1 · Contactos
// ---------------------------------------------------------------------

/**
 * Los contactos visibles de una empresa: los que guardó este workspace
 * y los del catálogo compartido (fuente pública y sin dueño, 0025 §6).
 * Lo que guardó OTRO workspace no se ve, aunque su fuente sea pública.
 * `isOwn` dice cuáles se pueden editar (false, nunca null, en los del
 * catálogo); la base rechazaría el resto.
 */
export async function listContacts(tx: WorkspaceTx, companyId: string): Promise<ContactRow[]> {
  if (!isUuid(companyId)) return [];
  const { rows } = await tx.query<ContactRowSql>(
    `SELECT id, company_id, full_name, role_title, email::text AS email, phone, linkedin_url,
            instagram_handle, source, source_url, opted_out, opted_out_at, opted_out_reason,
            bounced, created_at,
            coalesce(owner_workspace_id = current_workspace_id(), false) AS is_own
     FROM contact
     WHERE company_id = $1
     ORDER BY opted_out ASC, full_name ASC NULLS LAST, created_at ASC`,
    [companyId],
  );
  return rows.map(toContactRow);
}

export interface CreateContactInput {
  companyId: string;
  /** Procedencia obligatoria: sin ella el contacto no se guarda. */
  source: ContactSource;
  fullName?: string | null;
  roleTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  instagramHandle?: string | null;
  sourceUrl?: string | null;
}

/**
 * Guarda un contacto. `owner_workspace_id` NO va en la lista de
 * columnas a propósito: lo pone la base (DEFAULT current_workspace_id())
 * y es el candado de la PII. La política de escritura además exige que
 * la empresa esté vinculada a este workspace, así que se comprueba
 * antes para poder decirlo en español en vez de devolver un 42501.
 */
export async function createContact(tx: WorkspaceTx, input: CreateContactInput): Promise<string> {
  if (!isUuid(input.companyId)) throw new CompanyNotFound();
  if (!CONTACT_SOURCES.includes(input.source)) {
    throw new VentasError('InvalidSource', 'Un contacto no se guarda sin decir de dónde salió.');
  }
  const linked = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1', [input.companyId]);
  if (linked.rows.length === 0) throw new CompanyNotFound();

  const email = normalizeEmail(input.email);
  if (email) {
    // El correo es único por dueño (0026 §2): choca solo con MIS
    // contactos. Uno del catálogo o de otro workspace con el mismo
    // correo no lo impide —antes el índice era global y era un oráculo—.
    const clash = await tx.query(
      'SELECT 1 FROM contact WHERE email = $1 AND owner_workspace_id = current_workspace_id() LIMIT 1',
      [email],
    );
    if (clash.rows.length > 0) {
      throw new VentasError('DuplicateEmail', 'Ya hay un contacto con ese correo.');
    }
  }
  if (!input.fullName?.trim() && !email && !input.instagramHandle?.trim()) {
    throw new VentasError('EmptyContact', 'Un contacto necesita al menos nombre, correo o usuario de Instagram.');
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO contact (company_id, full_name, role_title, email, phone, linkedin_url,
                          instagram_handle, source, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.companyId,
      input.fullName?.trim() || null,
      input.roleTitle?.trim() || null,
      email,
      input.phone?.trim() || null,
      input.linkedinUrl?.trim() || null,
      normalizeHandle(input.instagramHandle),
      input.source,
      input.sourceUrl?.trim() || null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new VentasError('CreateFailed', 'No se pudo guardar el contacto.');
  return id;
}

export interface UpdateContactInput {
  fullName?: string | null;
  roleTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  instagramHandle?: string | null;
  source?: ContactSource;
  sourceUrl?: string | null;
}

/** Edita un contacto propio. Uno ajeno no se toca: la política lo rechaza y aquí se dice por qué. */
export async function updateContact(tx: WorkspaceTx, contactId: string, input: UpdateContactInput): Promise<void> {
  if (!isUuid(contactId)) throw new ContactNotFound();
  if (input.source !== undefined && !CONTACT_SOURCES.includes(input.source)) {
    throw new VentasError('InvalidSource', 'Esa procedencia no existe.');
  }
  const own = await tx.query<{ is_own: boolean }>(
    'SELECT coalesce(owner_workspace_id = current_workspace_id(), false) AS is_own FROM contact WHERE id = $1',
    [contactId],
  );
  const row = own.rows[0];
  if (!row) throw new ContactNotFound();
  if (!row.is_own) throw new ContactNotOwned();

  const email = input.email === undefined ? undefined : normalizeEmail(input.email);
  if (email) {
    const clash = await tx.query(
      'SELECT 1 FROM contact WHERE email = $1 AND id <> $2 AND owner_workspace_id = current_workspace_id() LIMIT 1',
      [email, contactId],
    );
    if (clash.rows.length > 0) throw new VentasError('DuplicateEmail', 'Ya hay un contacto con ese correo.');
  }

  const { rowCount } = await updateContactRow(tx, contactId, input, email);
  if (rowCount === 0) throw new ContactNotOwned();
}

async function updateContactRow(
  tx: WorkspaceTx,
  contactId: string,
  input: UpdateContactInput,
  email: string | null | undefined,
): Promise<{ rowCount: number }> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE contact SET
       full_name        = CASE WHEN $2::boolean THEN $3 ELSE full_name END,
       role_title       = CASE WHEN $4::boolean THEN $5 ELSE role_title END,
       email            = CASE WHEN $6::boolean THEN $7::citext ELSE email END,
       phone            = CASE WHEN $8::boolean THEN $9 ELSE phone END,
       linkedin_url     = CASE WHEN $10::boolean THEN $11 ELSE linkedin_url END,
       instagram_handle = CASE WHEN $12::boolean THEN $13 ELSE instagram_handle END,
       source           = COALESCE($14, source),
       source_url       = CASE WHEN $15::boolean THEN $16 ELSE source_url END,
       updated_at       = now()
     WHERE id = $1
     RETURNING id`,
    [
      contactId,
      input.fullName !== undefined, input.fullName?.trim() || null,
      input.roleTitle !== undefined, input.roleTitle?.trim() || null,
      email !== undefined, email ?? null,
      input.phone !== undefined, input.phone?.trim() || null,
      input.linkedinUrl !== undefined, input.linkedinUrl?.trim() || null,
      input.instagramHandle !== undefined, normalizeHandle(input.instagramHandle),
      input.source ?? null,
      input.sourceUrl !== undefined, input.sourceUrl?.trim() || null,
    ],
  );
  return { rowCount: rows.length };
}

/**
 * Registra la baja de un contacto propio. Es de una sola dirección: un
 * trigger impide que `opted_out` vuelva a false, así que esta capa no
 * ofrece lo contrario y la pantalla lo pide con confirmación.
 */
export async function optOutContact(tx: WorkspaceTx, contactId: string, reason: string | null): Promise<void> {
  if (!isUuid(contactId)) throw new ContactNotFound();
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE contact
     SET opted_out = true,
         opted_out_at = COALESCE(opted_out_at, now()),
         opted_out_reason = COALESCE($2, opted_out_reason),
         updated_at = now()
     WHERE id = $1 AND owner_workspace_id = current_workspace_id()
     RETURNING id`,
    [contactId, reason?.trim() || null],
  );
  if (rows.length === 0) {
    const exists = await tx.query('SELECT 1 FROM contact WHERE id = $1', [contactId]);
    throw exists.rows.length > 0 ? new ContactNotOwned() : new ContactNotFound();
  }
}

// ---------------------------------------------------------------------
// VEN-2 · Radar
// ---------------------------------------------------------------------

export interface ListSignalsParams {
  status?: SignalStatus;
  /** 1..200. Por defecto 100. */
  limit?: number;
}

/**
 * La bandeja del radar. Por defecto las pendientes, de mayor a menor
 * encaje: es el orden en que se revisan.
 */
export async function listSignals(tx: WorkspaceTx, params: ListSignalsParams = {}): Promise<SignalRow[]> {
  const status = params.status ?? 'pending';
  const limit = safeLimit(params.limit, 100, 200);
  const { rows } = await tx.query<SignalRowSql>(
    // Una señal manual o de CSV no tiene company_id hasta que se acepta:
    // el nombre y el dominio que se escribieron viven en `evidence`.
    `SELECT s.id, s.company_id,
            COALESCE(co.name, s.evidence->>'company_name')              AS company_name,
            COALESCE(co.domain::text, s.evidence->>'domain')            AS company_domain,
            (cl.company_id IS NOT NULL) AS company_linked,
            s.source_id, COALESCE(src.label_es, s.source_id) AS source_label,
            s.headline_es, s.detected_at, s.evidence_url, s.fit_score::text AS fit_score,
            s.budget_estimate::text AS budget_estimate, s.budget_currency::text AS budget_currency,
            s.dedupe_key, s.status, s.discard_reason, s.reviewed_at,
            COALESCE(s.evidence->>'via', 'manual') AS via
     FROM signal s
     LEFT JOIN company co        ON co.id = s.company_id
     LEFT JOIN company_link cl   ON cl.company_id = s.company_id
     LEFT JOIN signal_source src ON src.id = s.source_id
     WHERE s.status = $1
     ORDER BY s.fit_score DESC NULLS LAST, s.detected_at DESC
     LIMIT $2`,
    [status, limit],
  );
  return rows.map(toSignalRow);
}

/** Cuántas señales esperan revisión. Lo pinta el KPI y la pestaña. */
export async function countPendingSignals(tx: WorkspaceTx): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM signal WHERE status = 'pending'",
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * La clave con la que una señal se reconoce como la misma.
 *
 * Determinista y estable: si una señal descartada vuelve a entrar con
 * la misma clave, el UNIQUE (workspace_id, dedupe_key) la rechaza y no
 * reaparece en la bandeja. Por eso la clave NO lleva la fecha de hoy —
 * eso haría «nueva» a la misma marca cada mañana— sino la fuente, el
 * identificador de la empresa y, si la hay, la referencia propia de la
 * señal.
 */
export function buildDedupeKey(sourceId: string, companyKey: string, ref?: string | null): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');
  const parts = [norm(sourceId), norm(companyKey)];
  if (ref?.trim()) parts.push(norm(ref));
  return parts.join(':');
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
  /** Ya existía una señal con la misma clave: no se creó otra. */
  duplicate: boolean;
  dedupeKey: string;
}

/**
 * Una señal escrita a mano o traída de un CSV de marcas.
 *
 * No crea la empresa: eso pasa al aceptarla. Guarda lo que se sabe en
 * `evidence` para que, si se acepta, la empresa nazca con dominio,
 * país y sector sin volver a teclearlos.
 */
export async function createSignal(tx: WorkspaceTx, input: CreateSignalInput): Promise<CreateSignalResult> {
  const headline = input.headlineEs.trim();
  if (!headline) throw new VentasError('InvalidHeadline', 'La señal necesita una línea que diga qué viste.');
  const sourceId = input.sourceId?.trim() || 'manual';
  const domain = normalizeDomain(input.domain);
  const companyName = input.companyName?.trim() || null;
  if (!input.companyId && !companyName && !domain) {
    throw new VentasError('InvalidCompany', 'Di de qué marca es la señal: su nombre o su dominio.');
  }
  if (input.companyId && !isUuid(input.companyId)) throw new CompanyNotFound();

  const companyKey = domain ?? companyName ?? input.companyId ?? '';
  const dedupeKey = buildDedupeKey(sourceId, companyKey);

  const evidence = {
    company_name: companyName,
    domain,
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
      input.companyId ?? null,
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
  return { id, duplicate: id === null, dedupeKey };
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
}

/**
 * Carga una lista de marcas como señales pendientes. Una fila que ya
 * entró —aunque se haya descartado— no vuelve a entrar: de eso se
 * encarga el UNIQUE (workspace_id, dedupe_key), no un filtro en la
 * pantalla, que se olvidaría en el siguiente archivo.
 */
export async function importSignals(tx: WorkspaceTx, rows: ImportSignalRow[]): Promise<ImportSignalsResult> {
  let created = 0;
  const duplicatedKeys: string[] = [];
  for (const row of rows) {
    const res = await createSignal(tx, {
      companyName: row.name,
      domain: row.domain,
      country: row.country,
      industry: row.industry,
      note: row.note,
      headlineEs: row.note?.trim() || `${row.name.trim()} entró por una lista de marcas`,
      via: 'csv',
    });
    if (res.duplicate) duplicatedKeys.push(res.dedupeKey);
    else created += 1;
  }
  return { created, duplicated: duplicatedKeys.length, duplicatedKeys };
}

export interface AcceptSignalResult {
  dealId: string;
  companyId: string;
  /** La empresa nació al aceptar la señal. */
  companyCreated: boolean;
}

/** Días que se le dan al primer pitch cuando se acepta una señal. */
export const PITCH_DUE_DAYS = 3;
/** La siguiente acción con la que nace un deal aceptado desde el radar. */
export const PITCH_ACTION = 'Enviar pitch';

/**
 * Aceptar una señal: crea o reutiliza la empresa, la vincula, abre un
 * deal en «nuevo» con «Enviar pitch» a tres días, deja la primera fila
 * del historial de etapas y la actividad que lo explica.
 *
 * Todo en la misma transacción que abrió la pantalla: o queda entero o
 * no queda nada. `FOR UPDATE` sobre la señal evita que dos pestañas
 * abiertas creen dos deals de la misma.
 */
export async function acceptSignal(tx: WorkspaceTx, signalId: string): Promise<AcceptSignalResult> {
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
  const evDomain = typeof ev.domain === 'string' ? ev.domain : null;
  const evCountry = typeof ev.country === 'string' ? ev.country : null;
  const evIndustry = typeof ev.industry === 'string' ? ev.industry : null;

  let companyId = sig.company_id;
  let companyCreated = false;

  if (!companyId) {
    const domain = normalizeDomain(evDomain);
    if (domain) {
      const found = await tx.query<{ id: string }>('SELECT id FROM company WHERE domain = $1 LIMIT 1', [domain]);
      companyId = found.rows[0]?.id ?? null;
    }
    if (!companyId) {
      if (!evName) throw new VentasError('InvalidCompany', 'La señal no dice de qué marca es. Edítala antes de aceptarla.');
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO company (name, domain, country, industry) VALUES ($1, $2, $3, $4) RETURNING id`,
        [evName, domain, evCountry, evIndustry],
      );
      companyId = inserted.rows[0]?.id ?? null;
      if (!companyId) throw new VentasError('CreateFailed', 'No se pudo crear la empresa de la señal.');
      companyCreated = true;
    }
    await tx.query('UPDATE signal SET company_id = $2 WHERE id = $1', [signalId, companyId]);
  }

  // Vincular es idempotente: si ya era una empresa del workspace, se
  // deja la relación como estaba (podía ser cliente) y solo se anota
  // que el radar la volvió a traer.
  await tx.query(
    `INSERT INTO company_link (workspace_id, company_id, relationship)
     VALUES (current_workspace_id(), $1, 'prospect')
     ON CONFLICT (workspace_id, company_id) DO NOTHING`,
    [companyId],
  );

  const dealName = evName ?? sig.headline_es;
  const deal = await tx.query<{ id: string }>(
    `INSERT INTO deal (workspace_id, company_id, origin_signal_id, name, stage_id, amount, currency,
                       next_action, next_action_due)
     SELECT current_workspace_id(), $1, $2, $3, 'nuevo', $4::numeric, w.currency, $5,
            date_trunc('day', now()) + ($6::int * interval '1 day') + interval '15 hours'
     FROM workspace w WHERE w.id = current_workspace_id()
     RETURNING id`,
    [companyId, signalId, truncate(dealName, 120), sig.budget_estimate, PITCH_ACTION, PITCH_DUE_DAYS],
  );
  const dealId = deal.rows[0]?.id;
  if (!dealId) throw new VentasError('CreateFailed', 'No se pudo abrir el negocio.');

  await tx.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by)
     VALUES ($1, NULL, 'nuevo', current_user_id())`,
    [dealId],
  );
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, body, metadata)
     VALUES (current_workspace_id(), $1, $2, current_user_id(), 'signal_detected', $3, $4, $5::jsonb)`,
    [
      companyId,
      dealId,
      truncate(sig.headline_es, 200),
      'Señal aceptada desde el radar.',
      JSON.stringify({ signal_id: signalId, source_id: sig.source_id }),
    ],
  );
  await tx.query(
    `UPDATE signal SET status = 'accepted', reviewed_by = current_user_id(), reviewed_at = now() WHERE id = $1`,
    [signalId],
  );

  return { dealId, companyId, companyCreated };
}

/**
 * Descartar una señal con su motivo. No se borra: se marca, y su
 * dedupe_key sigue ocupando el UNIQUE, que es lo que impide que la
 * misma vuelva a la bandeja mañana.
 */
export async function discardSignal(tx: WorkspaceTx, signalId: string, reason: string): Promise<void> {
  if (!isUuid(signalId)) throw new SignalNotFound();
  const motivo = reason.trim();
  if (!motivo) throw new VentasError('InvalidReason', 'Di por qué la descartas: es lo que afina el radar.');
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

// ---------------------------------------------------------------------
// VEN-3 · Pipeline
// ---------------------------------------------------------------------

/**
 * Los deals del workspace por etapa y, dentro de cada una, por fecha de
 * siguiente acción. Sale de la vista deal_pipeline, que ya resuelve
 * probabilidad, monto ponderado y estado del seguimiento; se le añaden
 * los días en la etapa actual (del historial) y el responsable.
 */
export async function listPipeline(tx: WorkspaceTx): Promise<PipelineDealRow[]> {
  const { rows } = await tx.query<PipelineRowSql>(
    `SELECT p.id, p.company_id, p.company_name, p.name, p.stage_id, p.stage_label, p.stage_position,
            p.amount::text AS amount, p.currency::text AS currency, p.probability::text AS probability,
            p.weighted_amount::text AS weighted_amount, p.next_action, p.next_action_due, p.due_state,
            p.last_contact_at, p.expected_close_date::text AS expected_close_date, p.is_won, p.is_lost,
            u.name AS owner_name,
            round(extract(epoch FROM now() - COALESCE(h.changed_at, d.created_at)) / 86400.0)::int AS days_in_stage
     FROM deal_pipeline p
     JOIN deal d ON d.id = p.id
     LEFT JOIN app_user u ON u.id = d.owner_user_id
     LEFT JOIN LATERAL (
       SELECT changed_at FROM deal_stage_history
       WHERE deal_id = p.id AND to_stage_id = p.stage_id
       ORDER BY changed_at DESC LIMIT 1
     ) h ON true
     ORDER BY p.stage_position ASC, p.next_action_due ASC NULLS LAST, p.name ASC`,
  );
  return rows.map(toPipelineRow);
}

/** Un deal del workspace por su id, o null si no existe (o no es suyo, o el id es imposible). */
export async function getPipelineDeal(tx: WorkspaceTx, dealId: string): Promise<PipelineDealRow | null> {
  if (!isUuid(dealId)) return null;
  const all = await listPipeline(tx);
  return all.find((d) => d.id === dealId) ?? null;
}

/**
 * Los cuatro números de arriba del módulo, todos en SQL y todos en la
 * moneda del workspace. Ninguna pantalla los suma: si mañana hace falta
 * otro, se añade aquí.
 *
 * «Ganado en el trimestre» usa won_at, no la etapa: un deal movido a
 * «Ganado» y luego reabierto no debe contar dos veces.
 */
export async function getSalesKpis(tx: WorkspaceTx): Promise<SalesKpis> {
  const { rows } = await tx.query<{
    pending_signals: string; open_deals: string; open_amount: string; weighted_amount: string;
    won_quarter: string; won_quarter_count: string; no_next_action: string; overdue: string; currency: string;
  }>(
    `SELECT
       (SELECT count(*) FROM signal WHERE status = 'pending')::text                      AS pending_signals,
       (SELECT count(*) FROM deal_pipeline WHERE NOT is_won AND NOT is_lost)::text        AS open_deals,
       (SELECT COALESCE(sum(amount), 0) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost)::text                                          AS open_amount,
       (SELECT COALESCE(sum(weighted_amount), 0) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost)::text                                          AS weighted_amount,
       (SELECT COALESCE(sum(amount), 0) FROM deal
         WHERE won_at >= date_trunc('quarter', now()))::text                              AS won_quarter,
       (SELECT count(*) FROM deal WHERE won_at >= date_trunc('quarter', now()))::text     AS won_quarter_count,
       (SELECT count(*) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost AND next_action IS NULL)::text                  AS no_next_action,
       (SELECT count(*) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost AND due_state = 'vencido')::text                AS overdue,
       (SELECT currency::text FROM workspace WHERE id = current_workspace_id())           AS currency`,
  );
  const r = rows[0];
  return {
    pendingSignals: Number(r?.pending_signals ?? 0),
    openDeals: Number(r?.open_deals ?? 0),
    openAmount: r?.open_amount ?? '0',
    weightedAmount: r?.weighted_amount ?? '0',
    wonQuarter: r?.won_quarter ?? '0',
    wonQuarterCount: Number(r?.won_quarter_count ?? 0),
    noNextActionCount: Number(r?.no_next_action ?? 0),
    overdueCount: Number(r?.overdue ?? 0),
    currency: r?.currency ?? 'COP',
  };
}

export interface StageTotal {
  stageId: string;
  labelEs: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  /** Probabilidad por defecto de la etapa, 0..1 como string decimal. */
  defaultProbability: string;
  dealCount: number;
  /** Suma de los montos de la columna, string decimal. */
  amount: string;
  /** Suma ponderada de la columna, string decimal. */
  weightedAmount: string;
}

/**
 * Cada etapa con lo que lleva encima: cuántos negocios y cuánto suman.
 *
 * Existe porque el tablero muestra el monto en la cabecera de cada
 * columna (como Pipedrive) y sumarlo en React sería aritmética de
 * métricas en la pantalla, que es justo lo que el repositorio no
 * permite. Devuelve TODAS las etapas, también las vacías: una columna
 * sin negocios sigue siendo una columna del tablero.
 */
export async function getStageTotals(tx: WorkspaceTx): Promise<StageTotal[]> {
  const { rows } = await tx.query<{
    id: string; label_es: string; position: number; is_won: boolean; is_lost: boolean;
    default_probability: string; deal_count: string; amount: string; weighted_amount: string;
  }>(
    `SELECT st.id, st.label_es, st.position, st.is_won, st.is_lost,
            st.default_probability::text                      AS default_probability,
            count(p.id)::text                                 AS deal_count,
            COALESCE(sum(p.amount), 0)::text                  AS amount,
            COALESCE(sum(p.weighted_amount), 0)::text         AS weighted_amount
     FROM pipeline_stage st
     LEFT JOIN deal_pipeline p ON p.stage_id = st.id
     GROUP BY st.id, st.label_es, st.position, st.is_won, st.is_lost, st.default_probability
     ORDER BY st.position ASC`,
  );
  return rows.map((r) => ({
    stageId: r.id,
    labelEs: r.label_es,
    position: r.position,
    isWon: r.is_won,
    isLost: r.is_lost,
    defaultProbability: r.default_probability,
    dealCount: Number(r.deal_count),
    amount: r.amount,
    weightedAmount: r.weighted_amount,
  }));
}

export interface MoveDealResult {
  dealId: string;
  fromStageId: string;
  toStageId: string;
  /** Días que pasó en la etapa que deja, con dos decimales. */
  daysInStage: string | null;
  isWon: boolean;
  isLost: boolean;
}

/**
 * Mueve un deal de etapa: escribe el historial con los días que pasó en
 * la que deja, y fija won_at o lost_at cuando la etapa de llegada es
 * terminal. Es idempotente: mover a la etapa en la que ya está no
 * escribe historial ni cambia fechas.
 *
 * `won_at` no se recalcula si ya existe, para que reabrir y volver a
 * ganar no mueva la fecha del cierre real. Al salir de una etapa
 * terminal, en cambio, la fecha se limpia: si no, el KPI del trimestre
 * seguiría contando un deal que volvió a estar abierto.
 */
export async function moveDeal(tx: WorkspaceTx, dealId: string, toStageId: string): Promise<MoveDealResult> {
  if (!isUuid(dealId)) throw new DealNotFound();
  const stage = await tx.query<{ id: string; is_won: boolean; is_lost: boolean }>(
    'SELECT id, is_won, is_lost FROM pipeline_stage WHERE id = $1',
    [toStageId],
  );
  const to = stage.rows[0];
  if (!to) throw new VentasError('InvalidStage', 'Esa etapa no existe.');

  const current = await tx.query<{ stage_id: string; created_at: string }>(
    'SELECT stage_id, created_at FROM deal WHERE id = $1 FOR UPDATE',
    [dealId],
  );
  const deal = current.rows[0];
  if (!deal) throw new DealNotFound();

  if (deal.stage_id === to.id) {
    return { dealId, fromStageId: deal.stage_id, toStageId: to.id, daysInStage: null, isWon: to.is_won, isLost: to.is_lost };
  }

  // Los días en la etapa que deja: desde que entró en ella (última fila
  // del historial con to_stage_id = la actual) o, si nunca se registró,
  // desde que nació el deal.
  const since = await tx.query<{ days: string }>(
    `SELECT round(extract(epoch FROM now() - COALESCE(h.changed_at, d.created_at)) / 86400.0, 2)::text AS days
     FROM deal d
     LEFT JOIN LATERAL (
       SELECT changed_at FROM deal_stage_history
       WHERE deal_id = d.id AND to_stage_id = d.stage_id
       ORDER BY changed_at DESC LIMIT 1
     ) h ON true
     WHERE d.id = $1`,
    [dealId],
  );
  const daysInStage = since.rows[0]?.days ?? null;

  // won_at y lost_at los decide la etapa de llegada, y la etapa se lee
  // aquí mismo con un JOIN en vez de mandar dos booleanos por parámetro:
  // así no hay forma de que la fila y las banderas se desincronicen.
  await tx.query(
    `UPDATE deal SET
       stage_id    = st.id,
       won_at      = CASE WHEN st.is_won  THEN COALESCE(deal.won_at, now())  ELSE NULL END,
       lost_at     = CASE WHEN st.is_lost THEN COALESCE(deal.lost_at, now()) ELSE NULL END,
       lost_reason = CASE WHEN st.is_lost THEN deal.lost_reason ELSE NULL END,
       updated_at  = now()
     FROM pipeline_stage st
     WHERE deal.id = $1 AND st.id = $2`,
    [dealId, to.id],
  );
  await tx.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, days_in_stage)
     VALUES ($1, $2, $3, current_user_id(), $4::numeric)`,
    [dealId, deal.stage_id, to.id, daysInStage],
  );
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, metadata)
     SELECT current_workspace_id(), d.company_id, d.id, current_user_id(), 'stage_change',
            (SELECT label_es FROM pipeline_stage WHERE id = $2) || ' → ' ||
            (SELECT label_es FROM pipeline_stage WHERE id = $3),
            jsonb_build_object('from', $2::text, 'to', $3::text, 'days_in_stage', $4::numeric)
     FROM deal d WHERE d.id = $1`,
    [dealId, deal.stage_id, to.id, daysInStage],
  );

  return { dealId, fromStageId: deal.stage_id, toStageId: to.id, daysInStage, isWon: to.is_won, isLost: to.is_lost };
}

// ---------------------------------------------------------------------
// Conversión de filas
// ---------------------------------------------------------------------

interface CompanyRowSql {
  id: string; name: string; domain: string | null; country: string | null; city: string | null;
  industry: string | null; niche_slugs: string[] | null; size_bucket: string | null;
  relationship: Relationship; fit_score: string | null; owner_user_id: string | null;
  owner_name: string | null; notes: string | null; linked_at: string;
  contact_count: string; opted_out_count: string; open_deal_count: string; open_deal_amount: string;
  pending_signal_count: string; last_activity_at: string | null;
}

interface CompanyDetailSql {
  legal_name: string | null; socials: Record<string, string> | null; runs_ads: boolean | null;
  ads_platforms: string[] | null; logo_url: string | null; enriched_at: string | null;
}

function toCompanyRow(r: CompanyRowSql): CompanyListRow {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    country: r.country,
    city: r.city,
    industry: r.industry,
    nicheSlugs: r.niche_slugs ?? [],
    sizeBucket: r.size_bucket,
    relationship: r.relationship,
    fitScore: r.fit_score,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    notes: r.notes,
    contactCount: Number(r.contact_count),
    optedOutCount: Number(r.opted_out_count),
    openDealCount: Number(r.open_deal_count),
    openDealAmount: r.open_deal_amount,
    pendingSignalCount: Number(r.pending_signal_count),
    lastActivityAt: r.last_activity_at,
    linkedAt: r.linked_at,
  };
}

interface ContactRowSql {
  id: string; company_id: string; full_name: string | null; role_title: string | null;
  email: string | null; phone: string | null; linkedin_url: string | null;
  instagram_handle: string | null; source: ContactSource; source_url: string | null;
  opted_out: boolean; opted_out_at: string | null; opted_out_reason: string | null;
  bounced: boolean; is_own: boolean; created_at: string;
}

function toContactRow(r: ContactRowSql): ContactRow {
  return {
    id: r.id,
    companyId: r.company_id,
    fullName: r.full_name,
    roleTitle: r.role_title,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedin_url,
    instagramHandle: r.instagram_handle,
    source: r.source,
    sourceUrl: r.source_url,
    optedOut: r.opted_out,
    optedOutAt: r.opted_out_at,
    optedOutReason: r.opted_out_reason,
    bounced: r.bounced,
    isOwn: r.is_own,
    createdAt: r.created_at,
  };
}

interface SignalRowSql {
  id: string; company_id: string | null; company_name: string | null; company_domain: string | null;
  company_linked: boolean; source_id: string; source_label: string; headline_es: string;
  detected_at: string; evidence_url: string | null; fit_score: string | null;
  budget_estimate: string | null; budget_currency: string | null; dedupe_key: string;
  status: SignalStatus; discard_reason: string | null; reviewed_at: string | null; via: string;
}

function toSignalRow(r: SignalRowSql): SignalRow {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    companyDomain: r.company_domain,
    companyLinked: r.company_linked,
    sourceId: r.source_id,
    sourceLabel: r.source_label,
    headlineEs: r.headline_es,
    detectedAt: r.detected_at,
    evidenceUrl: r.evidence_url,
    fitScore: r.fit_score,
    budgetEstimate: r.budget_estimate,
    budgetCurrency: r.budget_currency,
    dedupeKey: r.dedupe_key,
    status: r.status,
    discardReason: r.discard_reason,
    reviewedAt: r.reviewed_at,
    via: r.via === 'csv' ? 'csv' : 'manual',
  };
}

interface PipelineRowSql {
  id: string; company_id: string; company_name: string; name: string; stage_id: string;
  stage_label: string; stage_position: number; amount: string | null; currency: string;
  probability: string; weighted_amount: string | null; next_action: string | null;
  next_action_due: string | null; due_state: DueState; last_contact_at: string | null;
  expected_close_date: string | null; is_won: boolean; is_lost: boolean;
  owner_name: string | null; days_in_stage: number;
}

function toPipelineRow(r: PipelineRowSql): PipelineDealRow {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    name: r.name,
    stageId: r.stage_id,
    stageLabel: r.stage_label,
    stagePosition: r.stage_position,
    amount: r.amount,
    currency: r.currency,
    probability: r.probability,
    weightedAmount: r.weighted_amount,
    nextAction: r.next_action,
    nextActionDue: r.next_action_due,
    dueState: r.due_state,
    lastContactAt: r.last_contact_at,
    expectedCloseDate: r.expected_close_date,
    isWon: r.is_won,
    isLost: r.is_lost,
    daysInStage: Number(r.days_in_stage ?? 0),
    ownerName: r.owner_name,
  };
}

// ---------------------------------------------------------------------
// Normalización de entradas
// ---------------------------------------------------------------------

/**
 * Un dominio como lo escribe una persona: con https://, con www, con
 * una ruta detrás, o en mayúsculas. Sale siempre el host en minúsculas,
 * que es lo que compara el índice único de `company (domain)`.
 */
export function normalizeDomain(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  const sinEsquema = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = sinEsquema.split('/')[0]?.split('?')[0]?.replace(/^www\./, '') ?? '';
  return host || null;
}

function normalizeCountry(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v || null;
}

/** «@cafealma» y «cafealma» son el mismo usuario. */
function normalizeHandle(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^@/, '');
  return v || null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------
// Trozos de SQL compartidos por la lista y el detalle de empresa
// ---------------------------------------------------------------------

/** El texto del usuario, con los comodines de LIKE escapados. */
const ESCAPE_LIKE = `replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

const CONTACT_COUNTS = `
  (SELECT count(*) FROM contact c WHERE c.company_id = co.id)::text                       AS contact_count,
  (SELECT count(*) FROM contact c WHERE c.company_id = co.id AND c.opted_out)::text       AS opted_out_count`;

const DEAL_COUNTS = `
  (SELECT count(*) FROM deal_pipeline dp
    WHERE dp.company_id = co.id AND NOT dp.is_won AND NOT dp.is_lost)::text               AS open_deal_count,
  (SELECT COALESCE(sum(dp.amount), 0) FROM deal_pipeline dp
    WHERE dp.company_id = co.id AND NOT dp.is_won AND NOT dp.is_lost)::text               AS open_deal_amount`;

const PENDING_SIGNALS = `
  (SELECT count(*) FROM signal s
    WHERE s.company_id = co.id AND s.status = 'pending')::text                            AS pending_signal_count`;

const LAST_ACTIVITY = `
  (SELECT max(a.occurred_at) FROM activity a WHERE a.company_id = co.id)                  AS last_activity_at`;

/** Las etapas, en orden, para pintar las columnas del tablero. */
export async function listStages(tx: WorkspaceTx): Promise<{ id: string; labelEs: string; position: number; isWon: boolean; isLost: boolean; defaultProbability: string }[]> {
  const { rows } = await tx.query<{
    id: string; label_es: string; position: number; is_won: boolean; is_lost: boolean; default_probability: string;
  }>(
    `SELECT id, label_es, position, is_won, is_lost, default_probability::text AS default_probability
     FROM pipeline_stage ORDER BY position ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    labelEs: r.label_es,
    position: r.position,
    isWon: r.is_won,
    isLost: r.is_lost,
    defaultProbability: r.default_probability,
  }));
}
