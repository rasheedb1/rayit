/**
 * El aviso al titular cuando un tercero conecta su cuenta (ACC-8). Un
 * solo sitio para los dos caminos —«Agregar cuenta» por @ y el callback
 * de OAuth—, para que la regla (a quién, cuándo no, con qué texto) no
 * diverja.
 *
 * El texto se arma aquí y no en @mc/db porque la fecha va en el locale y
 * la zona del workspace (formatterFor) y @mc/db no escribe frases.
 */
import { notifyConnectionAdded, type ConsentCreator, type SessionMember, type WorkspaceTx } from "@mc/db";
import { getWorkspaceSettings } from "@mc/db/queries/cimientos";
import { formatterFor } from "@/lib/format";
import { displayNameOf, MESSAGES } from "./messages";

/**
 * Qué pasó con el aviso al titular:
 *   sent               un tercero conectó la cuenta y el titular tiene un aviso nuevo
 *   already_pending    un tercero la conectó y el titular ya tenía ese aviso sin leer
 *   owner_acted        la conectó el propio titular: no hay a quién avisar
 *   no_owner_account   el perfil del creador no tiene app_user (seed, alta por agencia)
 *   no_session         copia sin llaves: no hay nadie en la sesión
 */
export type OwnerNotice = "sent" | "already_pending" | "owner_acted" | "no_owner_account" | "no_session";

export interface OwnerNoticeInput {
  creator: ConsentCreator;
  /** Quien actúa, tal como lo devolvió requireConexionesPermission. */
  actor: SessionMember | null;
  connectionId: string;
  /** El nombre de la red para la frase («Instagram», «TikTok»). */
  network: string;
  handle: string;
  at: Date;
}

/** Deja el aviso connection_added al titular si actuó un tercero, en la misma transacción que la conexión. */
export async function notifyOwner(tx: WorkspaceTx, p: OwnerNoticeInput): Promise<OwnerNotice> {
  if (!p.actor) return "no_session";
  if (p.actor.userId === p.creator.userId) return "owner_acted";
  if (!p.creator.userId) return "no_owner_account";
  const f = formatterFor(await getWorkspaceSettings(tx));
  const body = MESSAGES.ownerNotice.body({ who: displayNameOf(p.actor) ?? p.actor.email, handle: p.handle, network: p.network, when: f.dateTime(p.at.toISOString()) });
  const sent = await notifyConnectionAdded(tx, { userId: p.creator.userId, connectionId: p.connectionId, titleEs: MESSAGES.ownerNotice.title, bodyEs: body });
  return sent ? "sent" : "already_pending";
}
