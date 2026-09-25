/**
 * Un enlace de baja que se puede pulsar en local (VEN-15).
 *
 * El seed de la demo guarda solo el sha256 de tokens al azar, a
 * propósito: nadie tiene esos enlaces. Para recorrer a mano el camino de
 * la baja hace falta uno cuyo token SÍ se conozca. crearEnlaceDeDemo lo
 * fabrica como lo haría el despachador: un token nuevo
 * (createOptoutToken), su fila en outbound_optout_link para el último
 * correo enviado de la demo (otro intento del mismo toque, con su propio
 * número), y la URL.
 *
 * La usan dos sitios, y ninguno toca Supabase:
 *   · la web en modo demo (sin DATABASE_URL, Postgres embebido con el
 *     seed): lib/db/cliente.ts lo crea al terminar el seed y lo imprime
 *     en el aviso de «modo demo» (docs/ventas-outreach.md §5.2);
 *   · scripts/demo-enlace-baja.ts, contra un Postgres local (Docker), que
 *     se niega con cualquier base remota.
 * Escribe outbound_optout_link, así que corre como el worker (asWorker) o
 * como quien administra la base local.
 */
import { createOptoutToken, optoutTokenHash } from '@mc/core/outreach/deliverability';

/** Lo mínimo para una consulta con parámetros (pg.Client, o una transacción de @mc/db en las pruebas). */
export interface Consultable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export type EnlaceDeDemo =
  | { ok: true; token: string; url: string; recipient: string; touchId: string; attempt: number }
  | { ok: false; reason: 'sin_toque' | 'demasiados' };

/**
 * El enlace, como lo escribiría el despachador: para el último correo
 * enviado a una ficha que no está de baja, otro intento con su token.
 */
export async function crearEnlaceDeDemo(q: Consultable, appUrl: string): Promise<EnlaceDeDemo> {
  const { rows } = await q.query(
    `SELECT t.id, t.workspace_id, t.contact_id, t.recipient_address::text AS recipient_address,
            coalesce((SELECT max(l.attempt) FROM outbound_optout_link l WHERE l.touch_id = t.id), 0) + 1 AS siguiente
       FROM outbound_touch t
       JOIN contact c ON c.id = t.contact_id
      WHERE t.channel = 'email' AND t.status = 'sent' AND t.recipient_address IS NOT NULL AND NOT c.opted_out
      ORDER BY t.sent_at DESC NULLS LAST, t.id
      LIMIT 1`,
  );
  const toque = rows[0] as
    | { id: string; workspace_id: string; contact_id: string; recipient_address: string; siguiente: number }
    | undefined;
  if (!toque) return { ok: false, reason: 'sin_toque' };
  const intento = Number(toque.siguiente);
  if (intento > 20) return { ok: false, reason: 'demasiados' };
  const token = createOptoutToken();
  await q.query(
    `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6::citext, now(), now())`,
    [optoutTokenHash(token), toque.workspace_id, toque.id, toque.contact_id, intento, toque.recipient_address],
  );
  return {
    ok: true,
    token,
    url: `${appUrl.replace(/\/+$/, '')}/baja/${token}`,
    recipient: toque.recipient_address,
    touchId: toque.id,
    attempt: intento,
  };
}

