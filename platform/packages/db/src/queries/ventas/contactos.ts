/**
 * Ventas · contactos de una empresa (VEN-1): leerlos, darlos de alta,
 * editarlos y darlos de baja. Dueño: Rasheed.
 */
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { CONTACT_SOURCES } from '../../schema/ventas.ts';
import { recordWorkspaceOptOut } from '../outreach/inbound.ts';
import { CompanyNotFound, ContactNotFound, ContactNotOwned, type ContactRow, type ContactSource, VentasError } from './comun.ts';
import { type ContactRowSql, normalizeEmail, normalizeHandle, toContactRow } from './interno.ts';

/**
 * Los contactos visibles de una empresa: los que guardó este workspace
 * y los del catálogo compartido (fuente pública y sin dueño, 0025 §6).
 * Lo que guardó OTRO workspace no se ve, aunque su fuente sea pública.
 * `isOwn` dice cuáles se pueden editar (false, nunca null, en los del
 * catálogo); la base rechazaría el resto.
 */
export async function listContacts(tx: WorkspaceTx, companyId: string): Promise<ContactRow[]> {
  if (!isUuid(companyId)) return [];
  // Una ficha compartida (fuente pública, sin dueño) no lleva las marcas
  // de UN workspace (0055 §2 y §8, VEN-15 r3): su rebote verificado y su
  // baja por enlace viven en outbound_bounce y outbound_workspace_optout,
  // con la RLS de este workspace. Aquí se suman para que la ficha diga
  // lo mismo que la regla que frena el envío.
  const { rows } = await tx.query<ContactRowSql>(
    `SELECT c.id, c.company_id, c.full_name, c.role_title, c.email::text AS email, c.phone, c.linkedin_url,
            c.instagram_handle, c.source, c.source_url,
            (c.opted_out OR wo.email IS NOT NULL) AS opted_out,
            coalesce(c.opted_out_at, wo.created_at) AS opted_out_at, c.opted_out_reason, c.opted_out_code,
            (c.bounced OR b.detected_at IS NOT NULL) AS bounced,
            coalesce(c.email_invalid_reason, b.reason) AS email_invalid_reason,
            coalesce(c.email_invalid_at, b.detected_at) AS email_invalid_at, c.created_at,
            coalesce(c.owner_workspace_id = current_workspace_id(), false) AS is_own
     FROM contact c
     LEFT JOIN outbound_workspace_optout wo ON wo.workspace_id = current_workspace_id() AND wo.email = c.email
     LEFT JOIN LATERAL (
       SELECT x.reason, x.detected_at FROM outbound_bounce x
        WHERE x.workspace_id = current_workspace_id() AND x.kind = 'hard' AND x.verified AND x.recipient_address = c.email
        ORDER BY x.detected_at DESC LIMIT 1) b ON true
     WHERE c.company_id = $1
     ORDER BY (c.opted_out OR wo.email IS NOT NULL) ASC, c.full_name ASC NULLS LAST, c.created_at ASC`,
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
    throw new VentasError('InvalidSource');
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
      throw new VentasError('DuplicateEmail');
    }
  }
  if (!input.fullName?.trim() && !email && !input.instagramHandle?.trim()) {
    throw new VentasError('EmptyContact');
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
  if (!id) throw new VentasError('ContactCreateFailed');
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
    throw new VentasError('InvalidSource');
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
    if (clash.rows.length > 0) throw new VentasError('DuplicateEmail');
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
 * ofrece lo contrario y la pantalla lo pide con confirmación. Su correo
 * entra además en la lista del workspace (outbound_workspace_optout,
 * entregabilidad §8.4): borrar la ficha y crearla otra vez con el mismo
 * correo no deshace la baja.
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
  await recordWorkspaceOptOut(tx, contactId, tx.workspaceId, 'manual');
}
