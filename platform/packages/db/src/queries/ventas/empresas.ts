/**
 * Ventas · empresas (VEN-1): la lista, el detalle, darlas de alta y
 * editarlas, y quién puede ser su dueño. Dueño: Rasheed.
 */
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { RELATIONSHIPS } from '../../schema/ventas.ts';
import { type CompanyDetail, type CompanyListRow, CompanyNotEditable, CompanyNotFound, DuplicateCompanyName, DuplicateDomain, normalizeDomain, type Relationship, searchTerm, VentasError } from './comun.ts';
import { type CompanyDetailSql, type CompanyRowSql, CONTACT_COUNTS, DEAL_COUNTS, ESCAPE_LIKE, LAST_ACTIVITY, normalizeCountry, PENDING_SIGNALS, safeLimit, toCompanyRow } from './interno.ts';

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
 *
 * Y no distingue tildes, eñes, mayúsculas ni espacios: «cafe alma»
 * encuentra «Café Alma» y «nandu» encuentra «Zeta Bebidas Ñandú».
 * ILIKE sí los distingue, así que se compara además la llave de marca
 * (brand_key, 0031/0032), que es la misma con la que el radar reconoce
 * una marca por su nombre. brand_key solo deja letras y números, así
 * que ahí no hay comodín de LIKE que escapar. El orden sigue siendo el
 * de similitud con lo escrito.
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
                            OR co.domain ILIKE '%' || ${ESCAPE_LIKE} || '%'
                            OR brand_key(co.name) LIKE '%' || brand_key($1) || '%')
      AND ($2::text IS NULL OR cl.relationship = $2)
    ORDER BY ${q ? `similarity(co.name, $1) DESC,` : ''} co.name ASC
    LIMIT $3
    `,
    [q, relationship, limit],
  );
  return rows.map(toCompanyRow);
}

/**
 * ¿Está esta empresa en el CRM de este workspace? Una sola fila de
 * company_link y nada más: la ficha lo pregunta ANTES de abrir su
 * límite de Suspense, para que una empresa que no existe (o de otro
 * espacio) responda 404 y el resto de la ficha, que es lo que tarda,
 * cargue detrás de un esqueleto.
 */
export async function companyInCrm(tx: WorkspaceTx, companyId: string): Promise<boolean> {
  if (!isUuid(companyId)) return false;
  const { rows } = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1 LIMIT 1', [companyId]);
  return rows.length > 0;
}

/**
 * El nombre de la empresa si está en el CRM del workspace, o null (no
 * existe, es de otro espacio o el id es imposible). Lo mismo que
 * companyInCrm con el dato que necesita el título de la pestaña de la
 * ficha: «Café Alma · Ventas» y no un «Empresa» igual para todas
 * (pulido r8). Una sola fila.
 */
export async function companyNameInCrm(tx: WorkspaceTx, companyId: string): Promise<string | null> {
  if (!isUuid(companyId)) return null;
  const { rows } = await tx.query<{ name: string }>(
    `SELECT co.name
       FROM company_link cl
       JOIN company co ON co.id = cl.company_id
      WHERE cl.company_id = $1
      LIMIT 1`,
    [companyId],
  );
  return rows[0]?.name ?? null;
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
           coalesce(co.owner_workspace_id = current_workspace_id(), false) AS is_own,
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
    isOwn: row.is_own,
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
  /**
   * Crear aunque el CRM ya tenga una empresa con el mismo nombre (dos
   * «Alma» de dos países). Es el nombre por el que se preguntó
   * (DuplicateCompanyName.params.name), no un sí a cualquier nombre: el
   * permiso vale solo si la empresa que choca tiene ese mismo brand_key.
   * Si después del aviso se escribió otro nombre que TAMBIÉN está en el
   * CRM, se vuelve a preguntar (pulido r8). Sin él, createCompany lanza
   * DuplicateCompanyName y la pantalla pregunta antes.
   */
  allowSameNameAs?: string | null;
}

/**
 * Crea la empresa y la vincula a este workspace.
 *
 * `company` es un catálogo global: si el dominio ya existe, la empresa
 * NO se duplica —se reutiliza la fila y se vincula—. Eso es lo correcto
 * para el catálogo y lo que evita dos «Café Alma» con la misma web;
 * pero si ya está vinculada a este workspace, se avisa, porque quien la
 * está creando no la encontró y probablemente escribió mal el nombre.
 *
 * Sin dominio, el dominio no puede avisar de nada: por eso, antes de
 * crear una empresa NUEVA, se busca el nombre (brand_key, la misma
 * normalización sin tildes que el radar) entre las empresas del CRM.
 * Si hay una y el dominio no las separa (a una de las dos le falta),
 * DuplicateCompanyName, salvo `allowSameNameAs` (pulido r7: quedaban dos
 * «Zumos Ñandú» en la lista sin ningún aviso).
 *
 * El responsable (company_link.owner_user_id) es el que se pida o, si
 * no se pide ninguno, quien la crea: la persona de la transacción
 * (current_user_id(); NULL sin sesión, en el modo demo). Así una
 * empresa nueva nunca nace «Sin responsable» cuando alguien la creó.
 */
export async function createCompany(tx: WorkspaceTx, input: CreateCompanyInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new VentasError('InvalidName');
  const domain = normalizeDomain(input.domain);
  const relationship = input.relationship && RELATIONSHIPS.includes(input.relationship) ? input.relationship : 'prospect';
  if (input.ownerUserId) await assertOwner(tx, input.ownerUserId);

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
    // `confirmed`: se preguntó por ESTE nombre y la persona dijo «Crear
    // igual». brand_key(NULL) es NULL, así que sin permiso nunca es true.
    const mismoNombre = await tx.query<{ id: string; name: string; confirmed: boolean | null }>(
      `SELECT co.id, co.name, brand_key(co.name) = brand_key($3::text) AS confirmed
         FROM company_link cl
         JOIN company co ON co.id = cl.company_id
        WHERE brand_key(co.name) = brand_key($1)
          AND ($2::text IS NULL OR co.domain IS NULL)
        ORDER BY cl.created_at ASC
        LIMIT 1`,
      [name, domain, input.allowSameNameAs?.trim() || null],
    );
    const previa = mismoNombre.rows[0];
    if (previa && previa.confirmed !== true) throw new DuplicateCompanyName(previa.name, previa.id);
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
    if (!companyId) throw new VentasError('CompanyCreateFailed');
  }

  await tx.query(
    `INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, notes)
     VALUES (current_workspace_id(), $1, COALESCE($2::uuid, current_user_id()), $3, $4)
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
    throw new VentasError('InvalidName');
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
       country     = CASE WHEN $13::boolean THEN $5 ELSE country END,
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
      input.country !== undefined,
    ],
  );
  if (editadas.length === 0) throw new CompanyNotEditable();

  await updateCompanyLink(tx, companyId, input);
}

/** La relación de este workspace con la empresa: su company_link. */
async function updateCompanyLink(tx: WorkspaceTx, companyId: string, input: UpdateCompanyInput): Promise<void> {
  if (input.relationship !== undefined || input.notes !== undefined || input.ownerUserId !== undefined) {
    if (input.relationship !== undefined && !RELATIONSHIPS.includes(input.relationship)) {
      throw new VentasError('InvalidRelationship');
    }
    if (input.ownerUserId) await assertOwner(tx, input.ownerUserId);
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

/**
 * El responsable de una empresa tiene que ser alguien de este espacio.
 * La columna solo exige que la persona exista (FK a app_user); sin esta
 * comprobación se podía dejar como responsable a alguien de otro
 * workspace con solo conocer su id.
 */
async function assertOwner(tx: WorkspaceTx, userId: string): Promise<void> {
  if (!isUuid(userId)) throw new VentasError('InvalidOwner');
  const { rows } = await tx.query(
    'SELECT 1 FROM membership WHERE workspace_id = current_workspace_id() AND user_id = $1',
    [userId],
  );
  if (rows.length === 0) throw new VentasError('InvalidOwner');
}

export interface OwnerOption {
  userId: string;
  /** El nombre, o el correo si todavía no tiene. */
  label: string;
}

/**
 * Las personas que pueden ser responsables de una empresa: los miembros
 * de este espacio (membership). Las lee la RLS de membership y de
 * app_user (0020, 0028): nadie de otro espacio. Desde 0034 (ACC-3) no
 * hay membresías de marca que excluir: la marca no tiene cuenta, tiene
 * un enlace (backlog §7, decisión 8).
 */
export async function listOwnerOptions(tx: WorkspaceTx): Promise<OwnerOption[]> {
  const { rows } = await tx.query<{ user_id: string; label: string }>(
    `SELECT m.user_id, coalesce(nullif(btrim(u.name), ''), u.email::text) AS label
       FROM membership m
       JOIN app_user u ON u.id = m.user_id
      WHERE m.workspace_id = current_workspace_id()
        AND membership_is_team(m.workspace_id, m.user_id)
      ORDER BY label ASC`,
  );
  return rows.map((r) => ({ userId: r.user_id, label: r.label }));
}
