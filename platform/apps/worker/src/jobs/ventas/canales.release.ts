/**
 * sales.channels_release · soltar en el proveedor lo que se desconectó (VEN-9).
 *
 * Desconectar en /ventas/canales solo cambia la fila a 'disconnected': la
 * web es mc_app y no puede tocar el token (secret_ref) ni los avisos
 * (provider_webhook_ids, 0040). El disparador de 0040 deja la fila con
 * released_at NULL, que es la cola de este job. Cada cinco minutos (y en
 * la limpieza del keepalive diario), como mc_worker, cada fila se
 * RECLAMA primero (release_claimed_at, 0041) y solo después se habla con
 * el proveedor: mientras dure el reclamo, reconectar esa misma cuenta
 * responde «espera un minuto» en vez de revivir una fila cuyo permiso
 * está a punto de revocarse. Si el proveedor falla, el reclamo se suelta
 * y la fila vuelve a la cola.
 *
 *   Gmail     revoca el permiso en Google (POST /revoke con el refresh
 *             token), borra el token del vault y la ref de la fila.
 *   Unipile   borra en Unipile los avisos de la cuenta y la cuenta: deja
 *             de cobrarse (§5.1, el costo variable dominante) y nuestra
 *             llave ya no puede hablar en nombre de esa sesión.
 *   pendiente una fila 'pending:<nonce>' que no terminó no tiene nada en
 *             el proveedor: se marca soltada y ya.
 *
 * Nunca se suelta algo que siga vivo en OTRO sitio. El mismo buzón o la
 * misma cuenta de Unipile puede estar conectada en otra fila viva (otro
 * espacio, tras desconectarla aquí): revocar el permiso de Google revoca
 * la concesión entera de ese usuario con nuestro cliente, y borrar la
 * cuenta de Unipile tumbaría la de la otra fila. En ese caso solo se
 * borra lo nuestro (el token de esta fila, sus avisos).
 *
 * Qué no se suelta hoy: sin GOOGLE_CLIENT_ID/SECRET no hay cómo revocar,
 * así que el token se queda cifrado en el vault hasta que las llaves
 * estén (borrarlo antes haría imposible revocar después); lo mismo con
 * Unipile sin UNIPILE_DSN/ACCESS_TOKEN. Un fallo de red o un 5xx deja la
 * fila en la cola y se reintenta en la siguiente vuelta.
 *
 * Cada llamada queda en api_call_log (los clientes de @mc/connectors la
 * escriben con la cuenta de canal). `runChannelsRelease` es una función
 * pura sobre la base y dos interfaces: la prueba corre con FakeGmail y
 * FakeUnipile.
 */
import {
  GoogleOAuth, isOutreachApiError, loadGoogleTokenConfig, loadUnipileConfig, PostgresOutreachCallLog, TokenCipherError, UnipileClient,
  type GoogleOAuthApi, type SecretStore, type UnipileApi,
} from '@mc/connectors';
import type { Queryable } from '../../runner/db.ts';
import { defineJob } from '../../runner/registry.ts';

export const CHANNELS_RELEASE_JOB_ID = 'sales.channels_release';
/** Cuántas cuentas por vuelta: pocas, la cola es de lo que se desconectó en cinco minutos. */
export const RELEASE_BATCH = 100;

export interface ReleaseDeps {
  /** Como mc_worker. */
  db: Queryable;
  secrets: SecretStore;
  /** null = faltan GOOGLE_CLIENT_ID/SECRET: los Gmail esperan. */
  google: Pick<GoogleOAuthApi, 'revoke'> | null;
  /** null = faltan UNIPILE_DSN/ACCESS_TOKEN: los LinkedIn e Instagram esperan. */
  unipile: Pick<UnipileApi, 'deleteAccount' | 'deleteWebhook'> | null;
  now: Date;
}

export interface ReleaseResult {
  /** Cuentas soltadas del todo en esta vuelta. */
  released: number;
  /** Permisos de Google revocados. */
  googleRevoked: number;
  /** Tokens borrados del vault. */
  secretsPurged: number;
  /** Cuentas y avisos borrados en Unipile. */
  unipileAccountsDeleted: number;
  unipileWebhooksDeleted: number;
  /** Seguía viva en otra fila: solo se borró lo de esta. */
  sharedKept: number;
  /** Esperan a que estén las llaves del proveedor. */
  waitingForKeys: number;
  /** Fallos (red, 5xx, nuestra configuración): la fila sigue en la cola. */
  failed: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  provider: 'gmail_oauth' | 'unipile';
  provider_account_id: string;
  secret_ref: string | null;
  provider_webhook_ids: string[];
  /**
   * El reclamo de esta vuelta (release_claimed_at, 0041), en texto: con
   * sus microsegundos, que un Date de JavaScript perdería y la comparación
   * de cierre ya no casaría.
   */
  claim: string;
}

/** Un reclamo más viejo que esto es de un job que murió a medias: otro lo puede tomar (0041). */
export const RELEASE_CLAIM_STALE_MINUTES = 15;

/** ¿El mismo buzón o la misma cuenta de Unipile sigue viva en otra fila (de cualquier espacio)? */
async function liveElsewhere(db: Queryable, r: Row): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM outreach_channel_account
      WHERE provider = $1 AND provider_account_id = $2 AND id <> $3 AND status IN ('connected', 'needs_reconnect', 'error')
      LIMIT 1`,
    [r.provider, r.provider_account_id, r.id],
  );
  return rows.length > 0;
}

/**
 * Reclama la fila ANTES de hablar con el proveedor, en una sentencia:
 * solo si sigue desconectada, sin soltar y sin un reclamo vivo. Devuelve
 * lo que se va a soltar (la ref y los avisos) tal como estaban en ese
 * instante. Desde aquí outreach_channel_connect no la revive ('releasing',
 * 0041): la persona que reconecta en este minuto espera, en vez de
 * quedarse con un permiso que Google retira un segundo después.
 */
async function claim(db: Queryable, id: string, staleBefore: Date): Promise<Row | null> {
  const { rows } = await db.query<Row>(
    `UPDATE outreach_channel_account
        SET release_claimed_at = clock_timestamp()
      WHERE id = $1 AND status = 'disconnected' AND released_at IS NULL
        AND (release_claimed_at IS NULL OR release_claimed_at < $2)
      RETURNING id, workspace_id, provider, provider_account_id, secret_ref, provider_webhook_ids, release_claimed_at::text AS claim`,
    [id, staleBefore],
  );
  return rows[0] ?? null;
}

/** El proveedor falló o faltan llaves: la fila vuelve a la cola, solo si el reclamo sigue siendo el nuestro. */
async function unclaim(db: Queryable, r: Row): Promise<void> {
  await db.query(
    `UPDATE outreach_channel_account SET release_claimed_at = NULL
      WHERE id = $1 AND workspace_id = $2 AND release_claimed_at = $3::timestamptz`,
    [r.id, r.workspace_id, r.claim],
  );
}

/**
 * Cierra la fila como soltada, solo si el reclamo sigue siendo el nuestro
 * (nadie la revivió: la conexión no puede mientras dure, y uno viejo que
 * otro job retomó ya no casa). El token de Google sale de la fila; el de
 * la ref reclamada se borra del vault aparte.
 */
async function markReleased(db: Queryable, r: Row, at: Date): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE outreach_channel_account
        SET released_at = $3, release_claimed_at = NULL, provider_webhook_ids = '{}',
            secret_ref = CASE WHEN provider = 'gmail_oauth' THEN NULL ELSE secret_ref END,
            scopes = CASE WHEN provider = 'gmail_oauth' THEN '{}' ELSE scopes END
      WHERE id = $1 AND workspace_id = $2 AND status = 'disconnected' AND release_claimed_at = $4::timestamptz
      RETURNING id`,
    [r.id, r.workspace_id, at, r.claim],
  );
  return rows.length === 1;
}

async function purgeSecret(db: Queryable, r: Row): Promise<boolean> {
  if (!r.secret_ref) return false;
  // Solo si ninguna fila la nombra ya (una fila por concesión: no debería, pero no se borra lo ajeno).
  const { rows } = await db.query(
    `DELETE FROM connection_secret s
      WHERE s.secret_ref = $1 AND s.workspace_id = $2
        AND NOT EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.secret_ref = s.secret_ref)
      RETURNING s.secret_ref`,
    [r.secret_ref, r.workspace_id],
  );
  return rows.length === 1;
}

export async function runChannelsRelease(deps: ReleaseDeps): Promise<ReleaseResult> {
  const { db, now } = deps;
  const r: ReleaseResult = {
    released: 0, googleRevoked: 0, secretsPurged: 0, unipileAccountsDeleted: 0, unipileWebhooksDeleted: 0, sharedKept: 0,
    waitingForKeys: 0, failed: 0,
  };
  const staleBefore = new Date(now.getTime() - RELEASE_CLAIM_STALE_MINUTES * 60_000);
  const { rows: queue } = await db.query<{ id: string }>(
    `SELECT id FROM outreach_channel_account
      WHERE status = 'disconnected' AND released_at IS NULL
        AND (release_claimed_at IS NULL OR release_claimed_at < $2)
      ORDER BY updated_at
      LIMIT $1`,
    [RELEASE_BATCH, staleBefore],
  );

  for (const { id } of queue) {
    // Otro job (el keepalive y este corren a la vez) o una reconexión se la llevaron: nada que hacer.
    const a = await claim(db, id, staleBefore);
    if (!a) continue;
    // Una conexión que no terminó: en el proveedor no hay nada nuestro.
    if (a.provider_account_id.startsWith('pending:')) {
      if (await markReleased(db, a, now)) r.released += 1;
      continue;
    }
    const shared = await liveElsewhere(db, a);
    try {
      if (a.provider === 'gmail_oauth') {
        if (a.secret_ref && !shared) {
          if (!deps.google) {
            r.waitingForKeys += 1;
            await unclaim(db, a);
            continue;
          }
          // La ref que devolvió el reclamo: la de ESTA fila desconectada. Una reconexión estrena otra (0041).
          const tokens = await deps.secrets.get(a.secret_ref);
          if (tokens) {
            await deps.google.revoke(tokens, { channelAccountId: a.id });
            r.googleRevoked += 1;
          }
        }
        if (!(await markReleased(db, a, now))) continue;
        if (await purgeSecret(db, a)) r.secretsPurged += 1;
      } else {
        if (!deps.unipile) {
          r.waitingForKeys += 1;
          await unclaim(db, a);
          continue;
        }
        for (const webhookId of a.provider_webhook_ids) {
          await deps.unipile.deleteWebhook(webhookId, { channelAccountId: a.id });
          r.unipileWebhooksDeleted += 1;
        }
        if (!shared) {
          await deps.unipile.deleteAccount(a.provider_account_id, { channelAccountId: a.id });
          r.unipileAccountsDeleted += 1;
        }
        if (!(await markReleased(db, a, now))) continue;
      }
      if (shared) r.sharedKept += 1;
      r.released += 1;
    } catch (err) {
      // Del proveedor (red, 5xx, nuestra configuración) o un token que no descifra (la llave, no la persona): la
      // fila vuelve a la cola y se reintenta en la siguiente vuelta. Lo demás es un error de verdad y sube.
      await unclaim(db, a);
      if (!isOutreachApiError(err) && !(err instanceof TokenCipherError)) throw err;
      r.failed += 1;
    }
  }
  return r;
}

export const canalesReleaseJob = defineJob(
  CHANNELS_RELEASE_JOB_ID,
  async (_payload, ctx) => {
    const callLog = new PostgresOutreachCallLog(ctx.db);
    // Refrescar y revocar solo piden el cliente y su secreto: el worker no necesita APP_URL.
    const googleCfg = loadGoogleTokenConfig(ctx.env);
    const unipileCfg = loadUnipileConfig(ctx.env);
    const r = await runChannelsRelease({
      db: ctx.db,
      secrets: ctx.secrets,
      google: 'config' in googleCfg ? new GoogleOAuth(googleCfg.config, { callLog, now: ctx.now }) : null,
      unipile: 'config' in unipileCfg ? new UnipileClient({ config: unipileCfg.config, callLog, now: ctx.now }) : null,
      now: ctx.now(),
    });
    if (r.released + r.failed > 0) ctx.logger.info('canales soltados en el proveedor', { ...r });
    // Lo que falla vuelve en la siguiente vuelta del cron (cinco minutos): reintentar ya no ayuda.
    return { processed: r.released, failed: r.failed, metadata: { ...r }, retry: false };
  },
  { retryOnItemFailure: false },
);
