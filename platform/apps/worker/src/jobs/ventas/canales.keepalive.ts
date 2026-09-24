/**
 * sales.channels_keepalive · mantiene vivos los canales de outreach (VEN-9).
 *
 * Cada hora (job_definition, 0038 y 0042), POR LOTES: cada corrida toma
 * las cuentas vivas que no se comprobaron en las últimas veinte horas
 * (keepalive_checked_at, de la más vieja a la más nueva, KEEPALIVE_BATCH
 * como mucho) y las recorre de cuatro en cuatro (max_concurrency). Cada
 * cuenta se comprueba una vez al día y 24 lotes cubren miles; si el job se
 * queda sin tiempo (ctx.signal), deja de tomar cuentas y las que quedan
 * encabezan la cola de la hora siguiente. Una sola corrida diaria que lo
 * recorría todo en serie se cortaba a medias con cientos de creadores.
 *
 *   1. Gmail. Cada cuenta del lote cuyo access token vence dentro del
 *      margen se renueva con su refresh token, en el MISMO sitio que usa
 *      el cliente de Gmail (freshGoogleTokens), y el token nuevo se
 *      reescribe con la MISMA secret_ref: una fila por concesión. Si Google
 *      responde invalid_grant, la cuenta pasa a needs_reconnect con aviso.
 *   2. Avisos. Una cuenta de Unipile conectada sin sus dos avisos, o con
 *      avisos dados de alta con OTRO secreto (la huella no es la de
 *      UNIPILE_WEBHOOK_SECRET: se rotó), los vuelve a dar de alta con el
 *      secreto actual y borra los viejos. Así rotar el secreto no pierde
 *      respuestas (docs/ventas-outreach.md §9.1).
 *   3. Unipile. Se pregunta por cada LinkedIn o Instagram del lote: caída
 *      → needs_reconnect con aviso; de vuelta → connected.
 *   4. Conciliación. Las cuentas de Unipile que ninguna fila nombra (una
 *      hosted auth que terminó bien en Unipile pero no se conectó aquí y
 *      cuyo borrado falló), con más de un día y nacidas de NUESTRA hosted
 *      auth (su `name` abre con nuestra llave de estado: las de otro
 *      entorno que comparta el tenant no se tocan), se borran: Unipile
 *      cobra cada cuenta cada mes.
 *   5. Limpieza. Las filas 'pending' que nadie terminó en dos días y los
 *      intentos fallidos o cancelados ya soltados hace más de siete se
 *      borran; lo desconectado se suelta con runChannelsRelease.
 *
 * En last_error solo quedan CÓDIGOS (CHANNEL_ERROR_CODES de @mc/db y
 * 'unipile_status:<X>'): la pantalla los traduce en su messages.ts, en el
 * idioma del espacio. El aviso de la campana sí lleva frase (la tabla
 * notification es de frases: title_es, body_es), de @mc/core.
 *
 * Qué NO cambia el estado de una cuenta: un problema nuestro o pasajero
 * (la llave, un token que no descifra, la red, un 5xx, un 429). Deja el
 * código 'transient' y se vuelve a intentar al día siguiente.
 *
 * Corre como mc_worker (BYPASSRLS): cada escritura filtra por id y
 * workspace_id. Ningún token entra en logs ni en metadata.
 * `runChannelsKeepalive` es una función pura sobre la base y dos
 * interfaces: las pruebas la corren en pglite con FakeGmail y FakeUnipile.
 */
import {
  channelSigningKeys, freshGoogleTokens, GoogleOAuth, isOutreachApiError, keyringFromEnv, loadGoogleOAuthConfig, loadUnipileConfig,
  MasterKeyError, PostgresOutreachCallLog, registerAccountWebhooks, UnipileClient, UNIPILE_ACCOUNT_WEBHOOK_SOURCES, UNIPILE_WEBHOOK_SECRET_ENV,
  verifyChannelState, webhookSecretFingerprint, type GoogleOAuthApi, type OAuthTokens, type SecretStore, type UnipileApi,
} from '@mc/connectors';
import { CANALES_TEXTOS, channelHealthName } from '@mc/core';
import { CHANNEL_ERROR_CODES, unipileStatusCode } from '@mc/db/queries/canales';
import type { Queryable } from '../../runner/db.ts';
import { runChannelsRelease, type ReleaseResult } from './canales.release.ts';
import { defineJob } from '../../runner/registry.ts';

export const CHANNELS_KEEPALIVE_JOB_ID = 'sales.channels_keepalive';

/**
 * Margen del refresco: todo token que vence en las próximas 25 horas se
 * renueva hoy. Un access token de Google dura una hora, así que en la
 * práctica cada Gmail se renueva en cada visita, que es la prueba de vida.
 */
export const KEEPALIVE_MARGIN_MS = 25 * 60 * 60 * 1000;
/** Cuántas cuentas por fase y por corrida. 24 corridas al día × 200 = 4.800 cuentas de cada proveedor. */
export const KEEPALIVE_BATCH = 200;
/** Una cuenta comprobada hace menos de esto no vuelve al lote: una visita al día. */
export const KEEPALIVE_RECHECK_HOURS = 20;
/** Cuántas a la vez, si job_definition no dice otra cosa (max_concurrency, 0042). */
export const KEEPALIVE_CONCURRENCY = 4;
/** Una fila 'pending' de más de dos días ya no la va a terminar nadie. */
export const PENDING_MAX_AGE_HOURS = 48;
/** Un intento fallido o cancelado ('pending:<nonce>' desconectado) se enseña una semana y después se borra. */
export const FAILED_ATTEMPT_MAX_AGE_DAYS = 7;
/** Una cuenta de Unipile sin fila no se concilia hasta que tiene un día: antes puede estar llegando su aviso. */
export const ORPHAN_MIN_AGE_HOURS = 24;

const WEBHOOKS_MISSING = CHANNEL_ERROR_CODES.webhooksMissing;
/** Una cuenta recién conectada tiene un momento sin avisos (la web los está dando de alta): no se toca. */
const WEBHOOKS_GRACE_MINUTES = 10;
const LIVE = ['connected', 'needs_reconnect', 'error'] as const;

const EMPTY_RELEASE: ReleaseResult = {
  released: 0, googleRevoked: 0, secretsPurged: 0, unipileAccountsDeleted: 0, unipileWebhooksDeleted: 0, sharedKept: 0, waitingForKeys: 0, failed: 0,
};

export interface KeepaliveWebhookConfig {
  /** UNIPILE_WEBHOOK_SECRET: el de los avisos nuevos. */
  secret: string;
  /** Su huella (webhookSecretFingerprint): la de una cuenta con avisos al día. */
  secretFingerprint: string;
  routeKey: Uint8Array;
  requestUrl: string;
}

export interface KeepaliveDeps {
  /** Como mc_worker. */
  db: Queryable;
  /** El vault de tokens (EncryptedSecretStore en producción). */
  secrets: SecretStore;
  /** null = GOOGLE_CLIENT_ID/SECRET no están: los Gmail no se tocan. */
  google: Pick<GoogleOAuthApi, 'refresh' | 'revoke'> | null;
  /** null = UNIPILE_DSN/ACCESS_TOKEN no están: los LinkedIn e Instagram no se tocan. */
  unipile: Pick<UnipileApi, 'getAccount' | 'deleteAccount' | 'deleteWebhook' | 'createWebhook'> & Partial<Pick<UnipileApi, 'listAccounts'>> | null;
  /** Con qué dar de alta los avisos. null = falta UNIPILE_WEBHOOK_SECRET, TOKEN_ENCRYPTION_KEY o APP_URL. */
  webhooks?: KeepaliveWebhookConfig | null;
  /**
   * Las llaves de estado de TOKEN_ENCRYPTION_KEY (todas sus versiones):
   * una cuenta de Unipile solo se concilia si su `name` abre con una de
   * ellas. Sin ellas, no se concilia nada.
   */
  stateKeys?: readonly Uint8Array[] | null;
  now: Date;
  marginMs?: number;
  /** Cuántas cuentas por fase en esta corrida (KEEPALIVE_BATCH). */
  batchSize?: number;
  /** Cuántas a la vez (KEEPALIVE_CONCURRENCY). */
  concurrency?: number;
  /** El tiempo del job: vencido, no se toman cuentas nuevas. */
  signal?: AbortSignal;
}

export interface KeepaliveResult {
  gmailRefreshed: number;
  gmailUnchanged: number;
  unipileChecked: number;
  /** Cuentas que el proveedor dio por caídas en esta corrida. */
  markedDown: number;
  /** Cuentas que volvieron a estar bien. */
  recovered: number;
  /** Cuentas de Unipile que tenían sus avisos caídos y ya los tienen. */
  webhooksRestored: number;
  /** Cuentas cuyos avisos se volvieron a dar de alta con el secreto actual (rotación). */
  webhooksRotated: number;
  /** Cuentas de Unipile sin fila que se borraron (conciliación). */
  orphansDeleted: number;
  /** Fallos nuestros o transitorios: no cambian el estado de la cuenta. */
  failed: number;
  pendingRemoved: number;
  /** Intentos fallidos o cancelados de hace más de una semana, borrados. */
  failedAttemptsRemoved: number;
  /** Cuentas del lote que no se alcanzaron a mirar (se acabó el tiempo): van primero en la corrida siguiente. */
  deferred: number;
  /** Lo desconectado que se soltó en el proveedor (runChannelsRelease). */
  release: ReleaseResult;
  skipped: { gmail: boolean; unipile: boolean };
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  channel: string;
  provider: 'gmail_oauth' | 'unipile';
  provider_account_id: string;
  display_name: string | null;
  secret_ref: string | null;
  status: string;
  provider_webhook_ids: string[];
  provider_webhook_secret_fp: string | null;
}

const COLUMNS = `id, workspace_id, channel, provider, provider_account_id, display_name, secret_ref, status, provider_webhook_ids,
                 provider_webhook_secret_fp`;

/**
 * Recorre `items` con `limit` a la vez. Con la señal vencida no toma
 * ninguno más; devuelve cuántos quedaron sin mirar.
 */
export async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<number> {
  let next = 0;
  let skipped = 0;
  const worker = async () => {
    for (;;) {
      if (next >= items.length) return;
      if (signal?.aborted) {
        skipped += items.length - next;
        next = items.length;
        return;
      }
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return skipped;
}

/**
 * La cuenta cayó: needs_reconnect con el CÓDIGO en last_error y un aviso
 * en la campana con la frase (`what`, de @mc/core). Solo avisa si la
 * cuenta estaba viva y bien: una ya caída no vuelve a avisar.
 */
async function markDown(db: Queryable, a: AccountRow, code: string, what: string, at: Date): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE outreach_channel_account SET status = 'needs_reconnect', last_error = $3, last_error_at = $4
      WHERE id = $1 AND workspace_id = $2 AND status IN ('connected', 'error') RETURNING id`,
    [a.id, a.workspace_id, code, at],
  );
  if (rows.length === 0) return false;
  const channel = channelHealthName(a.channel);
  await db.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     VALUES ($1, 'connection_error', 'critical', $2, $3, 'outreach_channel_account', $4, '/ventas/canales')`,
    [a.workspace_id, CANALES_TEXTOS.down.title(channel, a.display_name), CANALES_TEXTOS.down.body(what), a.id],
  );
  return true;
}

async function markOk(db: Queryable, a: AccountRow, at: Date): Promise<boolean> {
  const { rows } = await db.query<{ was: string }>(
    // Un aviso pendiente de dar de alta no se borra al comprobar la sesión: lo borra quien los da de alta.
    `UPDATE outreach_channel_account n SET status = 'connected', last_ok_at = $3,
            last_error = CASE WHEN n.last_error = '${WEBHOOKS_MISSING}' THEN n.last_error END,
            last_error_at = CASE WHEN n.last_error = '${WEBHOOKS_MISSING}' THEN n.last_error_at END
       FROM outreach_channel_account o
      WHERE n.id = o.id AND n.id = $1 AND n.workspace_id = $2 AND n.status IN ('connected', 'needs_reconnect', 'error')
      RETURNING o.status AS was`,
    [a.id, a.workspace_id, at],
  );
  return rows[0] !== undefined && rows[0].was !== 'connected';
}

/** Un fallo nuestro o pasajero: el código 'transient'. El texto del proveedor queda en api_call_log. */
async function noteFailure(db: Queryable, a: AccountRow, at: Date): Promise<void> {
  await db.query(
    `UPDATE outreach_channel_account SET last_error = $3, last_error_at = $4 WHERE id = $1 AND workspace_id = $2`,
    [a.id, a.workspace_id, CHANNEL_ERROR_CODES.transient, at],
  );
}

/** La cuenta ya se miró en esta corrida: sale de la cola hasta mañana. */
async function checked(db: Queryable, a: AccountRow, at: Date): Promise<void> {
  await db.query(`UPDATE outreach_channel_account SET keepalive_checked_at = $3 WHERE id = $1 AND workspace_id = $2`, [a.id, a.workspace_id, at]);
}

/** El lote de un proveedor: las vivas que no se miraron en KEEPALIVE_RECHECK_HOURS, de la más vieja a la más nueva. */
async function dueAccounts(db: Queryable, provider: AccountRow['provider'], statuses: readonly string[], now: Date, limit: number): Promise<AccountRow[]> {
  const { rows } = await db.query<AccountRow>(
    `SELECT ${COLUMNS}
       FROM outreach_channel_account
      WHERE provider = $1 AND status = ANY($2::text[])
        AND (keepalive_checked_at IS NULL OR keepalive_checked_at < $3::timestamptz - make_interval(hours => $4))
      ORDER BY keepalive_checked_at NULLS FIRST, id
      LIMIT $5`,
    [provider, [...statuses], now, KEEPALIVE_RECHECK_HOURS, limit],
  );
  return rows;
}

/**
 * Las cuentas de Unipile conectadas cuyos avisos no están al día: les
 * falta alguno, o se dieron de alta con otro secreto (la huella no es la
 * del actual: el secreto se rotó, o son de antes de 0042). A una recién
 * conectada no se la toca: la web le está dando de alta los suyos.
 *
 * Por cada una: los dos avisos con el secreto actual; si salen los dos,
 * los viejos se borran en Unipile y la fila queda con los nuevos y la
 * huella actual (un viejo que no se pudo borrar se queda anotado, para que
 * sales.channels_release lo borre al soltar la cuenta). Si falta alguno,
 * la cuenta que no tenía avisos queda con webhooks_missing; la que los
 * tenía con el secreto anterior los conserva (siguen valiendo mientras
 * dure UNIPILE_WEBHOOK_SECRET_PREVIOUS) y se reintenta en la próxima.
 */
async function refreshWebhooks(
  db: Queryable,
  unipile: Pick<UnipileApi, 'createWebhook' | 'deleteWebhook'>,
  cfg: KeepaliveWebhookConfig,
  now: Date,
  limit: number,
  concurrency: number,
  r: KeepaliveResult,
  signal?: AbortSignal,
): Promise<void> {
  const { rows } = await db.query<AccountRow>(
    `SELECT ${COLUMNS}
       FROM outreach_channel_account
      WHERE provider = 'unipile' AND status = 'connected' AND provider_account_id NOT LIKE 'pending:%'
        AND (cardinality(provider_webhook_ids) < $3 OR provider_webhook_secret_fp IS DISTINCT FROM $4)
        AND updated_at < $1::timestamptz - make_interval(mins => $2)
      ORDER BY id
      LIMIT $5`,
    [now, WEBHOOKS_GRACE_MINUTES, UNIPILE_ACCOUNT_WEBHOOK_SOURCES.length, cfg.secretFingerprint, limit],
  );
  r.deferred += await forEachLimited(rows, concurrency, async (a) => {
    const old = a.provider_webhook_ids;
    const rotating = old.length >= UNIPILE_ACCOUNT_WEBHOOK_SOURCES.length;
    const { created, failed } = await registerAccountWebhooks({
      unipile, providerAccountId: a.provider_account_id, route: { workspaceId: a.workspace_id, channelAccountId: a.id },
      routeKey: cfg.routeKey, secret: cfg.secret, requestUrl: cfg.requestUrl, now,
    });
    if (failed) {
      // Lo que sí se creó queda anotado (se borra al soltar); la huella no cambia: mañana se vuelve a intentar.
      await db.query(
        `UPDATE outreach_channel_account
            SET provider_webhook_ids = (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(provider_webhook_ids || $3::text[]) x),
                last_error = CASE WHEN $4 THEN last_error ELSE $5 END,
                last_error_at = CASE WHEN $4 THEN last_error_at ELSE $6::timestamptz END
          WHERE id = $1 AND workspace_id = $2 AND status = 'connected'`,
        [a.id, a.workspace_id, created, rotating, WEBHOOKS_MISSING, now],
      );
      r.failed += 1;
      return;
    }
    const kept: string[] = [];
    for (const id of old) {
      try {
        await unipile.deleteWebhook(id, { channelAccountId: a.id });
      } catch (err) {
        if (!isOutreachApiError(err)) throw err;
        kept.push(id);
      }
    }
    await db.query(
      `UPDATE outreach_channel_account
          SET provider_webhook_ids = (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest($3::text[]) x),
              provider_webhook_secret_fp = $4,
              last_error = CASE WHEN last_error = $5 THEN NULL ELSE last_error END,
              last_error_at = CASE WHEN last_error = $5 THEN NULL ELSE last_error_at END
        WHERE id = $1 AND workspace_id = $2 AND status = 'connected'`,
      [a.id, a.workspace_id, [...created, ...kept], cfg.secretFingerprint, WEBHOOKS_MISSING],
    );
    if (rotating) r.webhooksRotated += 1;
    else r.webhooksRestored += 1;
  }, signal);
}

/**
 * Las cuentas de Unipile que ninguna fila nombra (ni viva, ni pendiente
 * de soltar), con más de ORPHAN_MIN_AGE_HOURS y nacidas de NUESTRA hosted
 * auth (el `name` abre con nuestra llave de estado), se borran. Es la red
 * del borrado que hace la web cuando una conexión no se completa (canal
 * equivocado, perfil duplicado u ocupado, la pendiente ya usada): si ese
 * borrado falló, la cuenta no se queda cobrando.
 */
async function reconcileOrphans(
  db: Queryable,
  unipile: Pick<UnipileApi, 'deleteAccount'> & Pick<UnipileApi, 'listAccounts'>,
  stateKeys: readonly Uint8Array[],
  now: Date,
  limit: number,
  r: KeepaliveResult,
): Promise<void> {
  const all = await unipile.listAccounts();
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_HOURS * 3600_000;
  const ours = all.filter((a) =>
    a.createdAt !== null && a.createdAt.getTime() < cutoff
    && verifyChannelState(a.hostedAuthName, stateKeys, now, Number.MAX_SAFE_INTEGER).ok);
  if (ours.length === 0) return;
  const { rows } = await db.query<{ provider_account_id: string }>(
    `SELECT DISTINCT provider_account_id FROM outreach_channel_account
      WHERE provider = 'unipile' AND provider_account_id = ANY($1::text[])
        AND NOT (status = 'disconnected' AND released_at IS NOT NULL)`,
    [ours.map((a) => a.id)],
  );
  const named = new Set(rows.map((x) => x.provider_account_id));
  for (const a of ours.filter((x) => !named.has(x.id)).slice(0, limit)) {
    try {
      await unipile.deleteAccount(a.id);
      r.orphansDeleted += 1;
    } catch (err) {
      if (!isOutreachApiError(err)) throw err;
      r.failed += 1;
    }
  }
}

export async function runChannelsKeepalive(deps: KeepaliveDeps): Promise<KeepaliveResult> {
  const { db, now, signal } = deps;
  const margin = deps.marginMs ?? KEEPALIVE_MARGIN_MS;
  const batch = Math.max(1, deps.batchSize ?? KEEPALIVE_BATCH);
  const concurrency = Math.max(1, deps.concurrency ?? KEEPALIVE_CONCURRENCY);
  const r: KeepaliveResult = {
    gmailRefreshed: 0, gmailUnchanged: 0, unipileChecked: 0, markedDown: 0, recovered: 0, webhooksRestored: 0, webhooksRotated: 0,
    orphansDeleted: 0, failed: 0, pendingRemoved: 0, failedAttemptsRemoved: 0, deferred: 0, release: EMPTY_RELEASE,
    skipped: { gmail: deps.google === null, unipile: deps.unipile === null },
  };

  // 1 · Gmail
  if (deps.google) {
    const google = deps.google;
    const lote = await dueAccounts(db, 'gmail_oauth', ['connected', 'error'], now, batch);
    r.deferred += await forEachLimited(lote, concurrency, async (a) => {
      await gmailOne(deps, google, a, margin, r);
      await checked(db, a, now);
    }, signal);
  }

  // 2 · Avisos. Antes de comprobar las sesiones: esa comprobación toca updated_at, que es lo que dice qué cuenta
  // acaba de conectarse (y a cuál la web le está dando de alta los avisos ahora mismo).
  if (deps.unipile && deps.webhooks) await refreshWebhooks(db, deps.unipile, deps.webhooks, now, batch, concurrency, r, signal);

  // 3 · Unipile
  if (deps.unipile) {
    const unipile = deps.unipile;
    const lote = await dueAccounts(db, 'unipile', LIVE, now, batch);
    r.deferred += await forEachLimited(lote, concurrency, async (a) => {
      await unipileOne(db, unipile, a, now, r);
      await checked(db, a, now);
    }, signal);
  }

  // 4 · Conciliación
  if (deps.unipile?.listAccounts && deps.stateKeys && deps.stateKeys.length > 0 && !signal?.aborted) {
    try {
      await reconcileOrphans(db, { listAccounts: deps.unipile.listAccounts.bind(deps.unipile), deleteAccount: deps.unipile.deleteAccount.bind(deps.unipile) },
        deps.stateKeys, now, batch, r);
    } catch (err) {
      if (!isOutreachApiError(err)) throw err;
      r.failed += 1;
    }
  }

  // 5 · Limpieza
  const pend = await db.query(
    `DELETE FROM outreach_channel_account WHERE status = 'pending' AND updated_at < $1::timestamptz - make_interval(hours => $2) RETURNING id`,
    [now, PENDING_MAX_AGE_HOURS],
  );
  r.pendingRemoved = pend.rows.length;
  // Un intento que no terminó (cancelado, fallido) se enseña una semana; ya soltado, no tiene nada en el proveedor.
  const intentos = await db.query(
    `DELETE FROM outreach_channel_account
      WHERE status = 'disconnected' AND provider_account_id LIKE 'pending:%'
        AND released_at IS NOT NULL AND released_at < $1::timestamptz - make_interval(days => $2)
      RETURNING id`,
    [now, FAILED_ATTEMPT_MAX_AGE_DAYS],
  );
  r.failedAttemptsRemoved = intentos.rows.length;
  if (!signal?.aborted) r.release = await runChannelsRelease({ db, secrets: deps.secrets, google: deps.google, unipile: deps.unipile, now });
  return r;
}

async function gmailOne(deps: KeepaliveDeps, google: NonNullable<KeepaliveDeps['google']>, a: AccountRow, margin: number, r: KeepaliveResult): Promise<void> {
  const { db, now } = deps;
  if (!a.secret_ref) {
    if (await markDown(db, a, CHANNEL_ERROR_CODES.gmailNoSecret, CANALES_TEXTOS.gmailNoSecret, now)) r.markedDown += 1;
    return;
  }
  let tokens: OAuthTokens | null;
  try {
    tokens = await deps.secrets.get(a.secret_ref);
  } catch {
    // No descifra: es nuestro (la clave), no de la persona. No se toca la cuenta.
    r.failed += 1;
    return;
  }
  if (!tokens) {
    if (await markDown(db, a, CHANNEL_ERROR_CODES.gmailNoSecret, CANALES_TEXTOS.gmailNoSecret, now)) r.markedDown += 1;
    return;
  }
  try {
    const fresh = await freshGoogleTokens(tokens, now, (t) => google.refresh(t, { channelAccountId: a.id }), margin);
    if (!fresh.refreshed) {
      r.gmailUnchanged += 1;
      return;
    }
    // Primero el vault (misma ref), después la fila: si el UPDATE falla, mañana se renueva con el token ya guardado.
    await deps.secrets.set(a.secret_ref, fresh.tokens);
    r.gmailRefreshed += 1;
    if (await markOk(db, a, now)) r.recovered += 1;
  } catch (err) {
    if (isOutreachApiError(err) && err.kind === 'not_connected') {
      if (await markDown(db, a, CHANNEL_ERROR_CODES.gmailRevoked, CANALES_TEXTOS.gmailRevoked, now)) r.markedDown += 1;
    } else {
      if (!isOutreachApiError(err)) throw err;
      r.failed += 1;
      await noteFailure(db, a, now);
    }
  }
}

async function unipileOne(db: Queryable, unipile: Pick<UnipileApi, 'getAccount'>, a: AccountRow, now: Date, r: KeepaliveResult): Promise<void> {
  r.unipileChecked += 1;
  const name = channelHealthName(a.channel);
  try {
    const acc = await unipile.getAccount(a.provider_account_id, { channelAccountId: a.id });
    if (acc.health === 'needs_reconnect') {
      if (await markDown(db, a, unipileStatusCode(acc.rawStatus), CANALES_TEXTOS.unipileStatus(acc.rawStatus, name), now)) r.markedDown += 1;
    } else if (acc.health === 'ok' && (await markOk(db, a, now))) {
      r.recovered += 1;
    }
  } catch (err) {
    if (isOutreachApiError(err) && (err.kind === 'not_connected' || err.code === 'errors/resource_not_found')) {
      if (await markDown(db, a, CHANNEL_ERROR_CODES.unipileGone, CANALES_TEXTOS.unipileGone(name), now)) r.markedDown += 1;
    } else {
      if (!isOutreachApiError(err)) throw err;
      r.failed += 1;
      await noteFailure(db, a, now);
    }
  }
}

/** Lo que hace falta para dar de alta un aviso desde el worker; null si falta algo (se registra, no se inventa). */
export function webhookConfig(env: Readonly<Record<string, string | undefined>>): KeepaliveDeps['webhooks'] {
  const secret = env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim();
  const appUrl = env['APP_URL']?.trim().replace(/\/+$/, '');
  if (!secret || !appUrl) return null;
  try {
    return {
      secret, secretFingerprint: webhookSecretFingerprint(secret), routeKey: channelSigningKeys(keyringFromEnv(env)).current.route,
      requestUrl: `${appUrl}/api/webhooks/unipile`,
    };
  } catch (err) {
    if (err instanceof MasterKeyError) return null;
    throw err;
  }
}

/** Las llaves de estado de todas las versiones de TOKEN_ENCRYPTION_KEY, para reconocer las cuentas nacidas de nuestra hosted auth. */
export function stateKeysFromEnv(env: Readonly<Record<string, string | undefined>>): Uint8Array[] | null {
  try {
    return channelSigningKeys(keyringFromEnv(env)).state;
  } catch (err) {
    if (err instanceof MasterKeyError) return null;
    throw err;
  }
}

export const canalesKeepaliveJob = defineJob(
  CHANNELS_KEEPALIVE_JOB_ID,
  async (_payload, ctx) => {
    const callLog = new PostgresOutreachCallLog(ctx.db);
    const googleCfg = loadGoogleOAuthConfig(ctx.env, ctx.env['APP_URL'] ?? null);
    const unipileCfg = loadUnipileConfig(ctx.env);
    const r = await runChannelsKeepalive({
      db: ctx.db,
      secrets: ctx.secrets,
      google: 'config' in googleCfg ? new GoogleOAuth(googleCfg.config, { callLog, now: ctx.now }) : null,
      unipile: 'config' in unipileCfg ? new UnipileClient({ config: unipileCfg.config, callLog, now: ctx.now }) : null,
      webhooks: webhookConfig(ctx.env),
      stateKeys: stateKeysFromEnv(ctx.env),
      now: ctx.now(),
      concurrency: ctx.definition.maxConcurrency || KEEPALIVE_CONCURRENCY,
      signal: ctx.signal,
    });
    ctx.logger.info('keepalive de canales', { ...r });
    // Un fallo transitorio se reintenta en el próximo lote: reintentar ya no ayuda.
    return { processed: r.gmailRefreshed + r.gmailUnchanged + r.unipileChecked, failed: r.failed + r.release.failed, metadata: { ...r }, retry: false };
  },
  { retryOnItemFailure: false },
);
