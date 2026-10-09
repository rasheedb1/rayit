/**
 * El token del dueño ANTES de leer con él (QA de Conexiones, 4-oct-2026).
 *
 * Los recolectores leían con el access token tal cual estaba en el
 * almacén, y un 401 por un token simplemente VENCIDO (TikTok: 24 h) se
 * convertía en `needs_reauth` aunque el refresh token valiera un año
 * más. Bastaba con que oauth.refresh no hubiera pasado a tiempo: el
 * worker apagado unos días, o dos turnos seguidos con la plataforma
 * caída. Así quedó @selvathegolden el 28-sep: access vencido el 25,
 * refresh vigente hasta 2027, y «vuelve a autorizar» por un fallo
 * nuestro de orquestación.
 *
 * Aquí, si el acceso ya venció, se renueva en línea con la MISMA lógica
 * de oauth.refresh (renovarConexion: almacén primero, después la base,
 * needs_reauth solo si la plataforma rechaza la renovación) y se lee con
 * el token nuevo. Un fallo pasajero de la renovación deja la cuenta como
 * transitoria, sin tocar su estado: la lee la corrida siguiente.
 */
import type { OAuthTokens } from '@mc/connectors';
import type { JobContext } from '../../runner/registry.ts';
import { renovarConexion, type ConnectionRow } from './oauth-refresh.ts';

/** Un token que vence en menos de un minuto no sirve para una lectura. */
export const TOKEN_MARGIN_MS = 60_000;

export type TokenListo =
  | { kind: 'ok'; tokens: OAuthTokens }
  /** El almacén no tiene la credencial: problema nuestro, no de la cuenta. */
  | { kind: 'sin_secreto' }
  /** La renovación falló de forma definitiva: la fila ya quedó en needs_reauth, con su aviso. */
  | { kind: 'needs_reauth'; code: string }
  /** La renovación falló de forma pasajera: no se toca el estado y se reintenta. */
  | { kind: 'transitorio'; code: string };

export function tokenVencido(tokens: OAuthTokens, now: Date): boolean {
  return tokens.accessExpiresAt.getTime() <= now.getTime() + TOKEN_MARGIN_MS;
}

/** La fila mínima que necesita la renovación (la misma que oauth.refresh). */
export type ConexionAutorizada = ConnectionRow;

export async function tokensListos(ctx: JobContext, conn: ConexionAutorizada): Promise<TokenListo> {
  const tokens = await ctx.secrets.get(conn.secret_ref);
  if (!tokens) return { kind: 'sin_secreto' };
  const now = ctx.now();
  if (!tokenVencido(tokens, now)) return { kind: 'ok', tokens };
  ctx.logger.info('el acceso venció antes de la lectura; se renueva en línea', {
    connectionId: conn.id, workspaceId: conn.workspace_id, platform: conn.platform_id, accessExpiresAt: tokens.accessExpiresAt.toISOString(),
  });
  const outcome = await renovarConexion(conn, ctx, now);
  if (outcome.kind === 'renewed') {
    const fresh = await ctx.secrets.get(conn.secret_ref);
    if (!fresh) return { kind: 'sin_secreto' };
    return { kind: 'ok', tokens: fresh };
  }
  if (outcome.kind === 'needs_reauth') return { kind: 'needs_reauth', code: outcome.code };
  return { kind: 'transitorio', code: outcome.code };
}
