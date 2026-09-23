/**
 * Cotizar · los avisos al creador: «la marca aceptó» (notification.kind =
 * 'quote_accepted') y «tu media kit quedó bloqueado» ('media_kit_locked').
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

// ---------------------------------------------------------------------
// Los avisos de «tu media kit quedó bloqueado» (kind = 'media_kit_locked')
// ---------------------------------------------------------------------

/**
 * Las frases del aviso, compuestas por la web con su messages.ts (este
 * paquete no tiene idioma). Sin cifras ni horas: el aviso se escribe
 * desde una petición pública, sin el locale del creador a mano, y la
 * pantalla lo recompone con kind + entity_id (listMediaKitLockNotices).
 */
export interface TextosBloqueoMediaKit {
  title: string;
  body: string;
}

/**
 * Deja el aviso al creador cuando el techo POR ENLACE (50 contraseñas
 * fallidas en una hora, sumando orígenes; 0030) bloquea un media kit
 * para todos, marca incluida. Sin esto el creador se enteraba cuando la
 * marca se quejaba. Lo llama el servidor con el workspace que devolvió
 * public_media_kit al saltar el techo (lib/db de la web), nunca uno que
 * venga del navegador.
 *
 * Uno sin leer por kit: si el techo vuelve a saltar antes de que el
 * creador lo vea, no se apilan. Devuelve true si dejó uno nuevo.
 */
export async function notifyMediaKitLocked(tx: WorkspaceTx, mediaKitId: string, textos: TextosBloqueoMediaKit): Promise<boolean> {
  if (!isUuid(mediaKitId)) return false;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     SELECT current_workspace_id(), 'media_kit_locked', 'warning', $2, $3, 'media_kit', k.id, '/cotizar/media-kit'
       FROM media_kit k
      WHERE k.id = $1
        AND NOT EXISTS (SELECT 1 FROM notification n
                         WHERE n.kind = 'media_kit_locked' AND n.entity_type = 'media_kit' AND n.entity_id = k.id
                           AND n.read_at IS NULL AND n.dismissed_at IS NULL)
     RETURNING id`,
    [mediaKitId, textos.title, textos.body],
  );
  return rows.length > 0;
}

/** Un aviso «tu media kit quedó bloqueado» sin leer, con lo que la pantalla necesita para componerlo. */
export interface MediaKitLockNotice {
  id: string;
  createdAt: string;
  mediaKitId: string;
  /** Cuándo se generó el kit: es como el creador los distingue en su lista. */
  mediaKitCreatedAt: string;
  /** Hasta cuándo sigue bloqueado el enlace, o null si ya se abrió (solo o con «Desbloquear»). */
  lockedUntil: string | null;
}

/** Los avisos de bloqueo que el creador todavía no ha dado por vistos, los más recientes primero. */
export async function listMediaKitLockNotices(tx: WorkspaceTx, limit = 5): Promise<MediaKitLockNotice[]> {
  const { rows } = await tx.query<{
    id: string; created_at: string; media_kit_id: string; kit_created_at: string; locked_until: string | null;
  }>(
    `SELECT n.id, n.created_at, k.id AS media_kit_id, k.created_at AS kit_created_at,
            CASE WHEN k.locked_until > now() THEN k.locked_until END AS locked_until
       FROM notification n
       JOIN media_kit k ON k.id = n.entity_id
      WHERE n.kind = 'media_kit_locked' AND n.entity_type = 'media_kit'
        AND n.read_at IS NULL AND n.dismissed_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 50))],
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    mediaKitId: r.media_kit_id,
    mediaKitCreatedAt: r.kit_created_at,
    lockedUntil: r.locked_until,
  }));
}

/** «Entendido» en un aviso de bloqueo. Solo toca avisos de bloqueo de este workspace (RLS). */
export async function markMediaKitLockNoticeRead(tx: WorkspaceTx, id: string): Promise<void> {
  if (!isUuid(id)) return;
  await tx.query(
    "UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND kind = 'media_kit_locked'",
    [id],
  );
}
