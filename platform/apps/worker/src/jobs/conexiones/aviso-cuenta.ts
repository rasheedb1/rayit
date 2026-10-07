/**
 * El aviso de una cuenta social rota (connection_error), escrito en UN
 * sitio por los tres caminos que la rompen (RES-3):
 *
 *   - oauth.refresh, cuando la plataforma rechaza la renovación;
 *   - el token rechazado al recolectar (markNeedsReauth de _posts.ts y
 *     collect.account_metrics);
 *   - la cuenta que ya no se puede leer (markAccountError y
 *     collect.account_metrics).
 *
 * Los tres comparten título y severidad (@mc/core cuentas.ts) Y la regla
 * para no repetirse (`notifyBrokenAccount`). Antes oauth.refresh tenía su
 * propio INSERT sin esa regla: si él y collect.posts rechazaban el token
 * el mismo día, la campana enseñaba dos avisos críticos de la misma
 * cuenta.
 *
 * Y un barrido (`remindBrokenAccounts`) para la cuenta que se queda rota
 * sin que nadie la vuelva a tocar: una en needs_reauth no la leen ni los
 * recolectores ni oauth.refresh, así que nadie escribía otro aviso. Un
 * «Entendido» por error en «Lo que importa esta semana» la sacaba para
 * siempre del Resumen. Con el barrido vuelve a la semana, como la cuenta
 * en 'error' (que se reintenta cada día y pasa por notifyBrokenAccount).
 *
 * Sin imports de otros jobs a propósito: oauth-refresh.ts y _posts.ts lo
 * usan los dos, y _posts.ts ya importa de oauth-refresh.ts.
 *
 * ctx.db corre como mc_worker, que se salta RLS: TODA consulta de este
 * archivo lleva workspace_id explícito o lo toma de la fila.
 */
import { connectionErrorSeverity, connectionErrorTitle, type BrokenAccountKind, type PlatformId } from '@mc/core';
import { PLATFORM_LABELS } from '@mc/core/plataformas';
import type { JobDatabase, Queryable } from '../../runner/db.ts';

/** Cada cuánto, como mucho, se repite el aviso de la MISMA avería de una cuenta. */
export const BROKEN_ACCOUNT_REPEAT_DAYS = 7;

/** El candado de transacción del aviso de UNA cuenta (ver notifyBrokenAccount). */
export const BROKEN_ACCOUNT_LOCK_PREFIX = 'connection_error:';

/** El nombre de la red para una frase; una red desconocida se dice tal cual. */
export function platformName(platformId: string): string {
  return Object.hasOwn(PLATFORM_LABELS, platformId) ? PLATFORM_LABELS[platformId as PlatformId] : platformId;
}

/** Lo que necesita el aviso de una cuenta rota: la cuenta, su espacio, su red y su @. */
export interface BrokenAccount {
  id: string;
  workspace_id: string;
  platform_id: string;
  handle: string | null;
}

/**
 * El aviso de una cuenta rota. Lo que «Lo que importa esta semana» enseña
 * con su enlace a Conexiones; sin aviso, la cuenta caía en silencio.
 *
 * Como mucho uno por cuenta y por semana para la MISMA avería: la cuenta
 * en 'error' se vuelve a intentar cada día (selectCollectableAccounts) y
 * cada intento fallido pasa por aquí. El aviso de la semana cuenta
 * aunque alguien lo haya descartado (dismissed_at): quien lo quitó de la
 * campana no lo vuelve a ver mañana con el reintento, lo vuelve a ver a
 * la semana, igual que en remindBrokenAccounts. Se escribe otro aviso si:
 *   - pasó una semana y sigue rota (sigue importando);
 *   - la avería subió de gravedad: un «No podemos leer» (warning) no
 *     calla el crítico del día siguiente, que tiene que ir arriba del
 *     bloque y no debajo de los cobros;
 *   - la cuenta se leyó bien después del último aviso
 *     (last_synced_at): es otra avería, aunque caiga en la misma semana.
 * Corre dentro de la transacción de quien cambia el estado de la cuenta:
 * el estado y su aviso entran juntos o no entra ninguno. Y TIENE que
 * correr en una: el candado de la cuenta (pg_advisory_xact_lock) se suelta
 * al cerrar la transacción. Sin él, collect.posts y
 * collect.account_metrics fallando a la vez sobre la misma cuenta veían
 * los dos «no hay aviso» (READ COMMITTED) y escribían dos. Con él, el
 * segundo espera al primero y, como cada sentencia de READ COMMITTED mira
 * lo confirmado hasta ese momento, ve su aviso y no escribe.
 *
 * Devuelve si escribió un aviso.
 */
export async function notifyBrokenAccount(tx: Queryable, acc: BrokenAccount, kind: BrokenAccountKind, detailEs: string | null): Promise<boolean> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${BROKEN_ACCOUNT_LOCK_PREFIX}${acc.id}`]);
  const { rows } = await tx.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     SELECT $1::uuid, 'connection_error', $2, $3, $4, 'social_connection', $5::uuid, '/conexiones'
      WHERE NOT EXISTS (
        SELECT 1 FROM notification n
         WHERE n.workspace_id = $1::uuid AND n.kind = 'connection_error' AND n.entity_type = 'social_connection'
           AND n.entity_id = $5::uuid
           AND n.created_at > now() - make_interval(days => $6::int)
           AND NOT ($2::text = 'critical' AND n.severity <> 'critical')
           AND n.created_at >= coalesce(
                 (SELECT s.last_synced_at FROM social_connection s WHERE s.id = $5::uuid AND s.workspace_id = $1::uuid),
                 '-infinity'::timestamptz))
     RETURNING id`,
    [
      acc.workspace_id,
      connectionErrorSeverity(kind),
      connectionErrorTitle(platformName(acc.platform_id), acc.handle, kind),
      detailEs,
      acc.id,
      BROKEN_ACCOUNT_REPEAT_DAYS,
    ],
  );
  return rows.length > 0;
}

/** Los estados de una cuenta a la que nadie vuelve a leer: sin token, solo la persona la arregla. */
const SIN_TOKEN = ['needs_reauth', 'expired', 'revoked'] as const;

/**
 * El recordatorio semanal de las cuentas que siguen sin token: las que
 * llevan BROKEN_ACCOUNT_REPEAT_DAYS días sin un aviso suyo (ni
 * descartado: quien lo quitó de la campana no lo vuelve a ver al minuto
 * siguiente, lo vuelve a ver a la semana). Cada una pasa por
 * notifyBrokenAccount, con su regla, en una transacción por cuenta (la
 * que su candado necesita). `workspaceId` lo limita a un espacio (la
 * corrida de una prueba o de la demo).
 *
 * Devuelve cuántos avisos escribió.
 */
export async function remindBrokenAccounts(db: JobDatabase, workspaceId: string | null = null): Promise<number> {
  const { rows } = await db.query<BrokenAccount & { status_detail: string | null; [k: string]: unknown }>(
    `SELECT c.id, c.workspace_id, c.platform_id, c.handle, c.status_detail
       FROM social_connection c
      WHERE c.status = ANY($1::text[]) AND c.deleted_at IS NULL
        AND ($2::uuid IS NULL OR c.workspace_id = $2::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM notification n
           WHERE n.workspace_id = c.workspace_id AND n.kind = 'connection_error' AND n.entity_type = 'social_connection'
             AND n.entity_id = c.id AND n.created_at > now() - make_interval(days => $3::int))
      ORDER BY c.workspace_id, c.id`,
    [SIN_TOKEN, workspaceId, BROKEN_ACCOUNT_REPEAT_DAYS],
  );
  let escritos = 0;
  for (const acc of rows) {
    if (await db.transaction((tx) => notifyBrokenAccount(tx, acc, 'reauth', acc.status_detail))) escritos += 1;
  }
  return escritos;
}
