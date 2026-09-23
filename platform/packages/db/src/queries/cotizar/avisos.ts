/**
 * Cotizar · los avisos de «la marca aceptó» (notification.kind = 'quote_accepted').
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import { isUuid, type WorkspaceTx } from '../../client.ts';

// ---------------------------------------------------------------------
// Los avisos de aceptación (notification.kind = 'quote_accepted')
// ---------------------------------------------------------------------

/**
 * Un aviso «la marca aceptó» sin leer, con los datos para componerlo en
 * la pantalla (no se reusa title_es: la frase la pone messages.ts).
 */
export interface AcceptanceNotice {
  id: string;
  createdAt: string;
  quoteId: string;
  quoteNumber: string;
  companyName: string;
  signerName: string | null;
  campaignName: string | null;
}

/** Los avisos de aceptación que el creador todavía no ha dado por vistos, los más recientes primero. */
export async function listAcceptanceNotices(tx: WorkspaceTx, limit = 5): Promise<AcceptanceNotice[]> {
  const { rows } = await tx.query<{
    id: string; created_at: string; quote_id: string; number: string; company_name: string;
    accepted_by_name: string | null; campaign_name: string | null;
  }>(
    `SELECT n.id, n.created_at, q.id AS quote_id, q.number, co.name AS company_name,
            q.accepted_by_name, ca.name AS campaign_name
       FROM notification n
       JOIN quote q ON q.id = n.entity_id
       JOIN company co ON co.id = q.company_id
       LEFT JOIN campaign ca ON ca.quote_id = q.id AND ca.status <> 'cancelled'
      WHERE n.kind = 'quote_accepted' AND n.entity_type = 'quote'
        AND n.read_at IS NULL AND n.dismissed_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 50))],
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    quoteId: r.quote_id,
    quoteNumber: r.number,
    companyName: r.company_name,
    signerName: r.accepted_by_name,
    campaignName: r.campaign_name,
  }));
}

/** «Entendido»: el aviso deja de salir. Solo toca avisos de aceptación de este workspace (RLS). */
export async function markAcceptanceNoticeRead(tx: WorkspaceTx, id: string): Promise<void> {
  if (!isUuid(id)) return;
  await tx.query(
    "UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND kind = 'quote_accepted'",
    [id],
  );
}
