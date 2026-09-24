/**
 * sales.channels_keepalive · mantiene vivos los canales de outreach (VEN-9).
 *
 * Una vez al día (job_definition, migración 0038):
 *
 *   1. Gmail. Cada cuenta conectada (o en error) cuyo access token vence
 *      dentro del margen se renueva con su refresh token, en el MISMO sitio
 *      que usa el cliente de Gmail (freshGoogleTokens de @mc/connectors), y
 *      el token nuevo se reescribe con la MISMA secret_ref: una fila por
 *      concesión, nunca otra (el error de Chief: el refresh token en cuatro
 *      sitios y el keepalive dejando uno caducado). Renovar a diario es lo
 *      que demuestra que el permiso sigue en pie: si Google responde
 *      invalid_grant (la persona quitó el acceso, o el refresh token venció
 *      sin uso), la cuenta pasa a needs_reconnect con un aviso.
 *   2. Avisos. Una cuenta de Unipile conectada que se quedó sin sus dos
 *      avisos (mensajes y salud: falló su alta al conectar) no se entera
 *      de las respuestas. Se vuelven a dar de alta con registerAccountWebhooks,
 *      lo mismo que hace la web al conectar y su botón «Volver a intentar».
 *   3. Unipile. Se pregunta por cada LinkedIn o Instagram: si su fuente
 *      está en CREDENTIALS, ERROR o STOPPED, o Unipile ya no la conoce, la
 *      cuenta pasa a needs_reconnect con un aviso; si vuelve a estar OK (se
 *      reconectó desde Unipile), vuelve a connected.
 *   4. Limpieza. Las filas 'pending' que nadie terminó en dos días se
 *      borran, y lo desconectado se suelta en el proveedor con la misma
 *      función que sales.channels_release (canales.release.ts): Google
 *      revocado y token fuera del vault; cuenta y avisos borrados en
 *      Unipile. El keepalive es la red de ese job: lo que falló allí se
 *      vuelve a intentar aquí.
 *
 * Qué NO cambia el estado de una cuenta: un problema nuestro (la llave de
 * Google o de Unipile sin configurar, un token que no descifra, la red, un
 * 5xx, un 429). Eso cuenta como fallo de la corrida, deja last_error para
 * la pantalla y el siguiente día se vuelve a intentar. Solo lo que dice el
 * PROVEEDOR tumba una cuenta.
 *
 * Corre como mc_worker (BYPASSRLS): cada escritura filtra por id y
 * workspace_id. Ningún token entra en logs ni en metadata.
 *
 * `runChannelsKeepalive` es una función pura sobre la base y dos
 * interfaces (GoogleOAuthApi, UnipileApi): las pruebas la corren en pglite
 * con FakeGmail y FakeUnipile.
 */
import {
  channelSigningKeys, freshGoogleTokens, GoogleOAuth, isOutreachApiError, keyringFromEnv, loadGoogleOAuthConfig, loadUnipileConfig,
  MasterKeyError, PostgresOutreachCallLog, registerAccountWebhooks, UnipileClient, UNIPILE_ACCOUNT_WEBHOOK_SOURCES, UNIPILE_WEBHOOK_SECRET_ENV,
  type GoogleOAuthApi, type OAuthTokens, type SecretStore, type UnipileApi,
} from '@mc/connectors';
import { CANALES_TEXTOS, channelHealthName } from '@mc/core';
import { CHANNEL_ERROR_CODES } from '@mc/db/queries/canales';
import type { Queryable } from '../../runner/db.ts';
import { runChannelsRelease, type ReleaseResult } from './canales.release.ts';
import { defineJob } from '../../runner/registry.ts';

export const CHANNELS_KEEPALIVE_JOB_ID = 'sales.channels_keepalive';

/**
 * Margen del keepalive: todo token que vence en las próximas 25 horas se
 * renueva hoy. Un access token de Google dura una hora, así que en la
 * práctica se renueva cada Gmail cada día, que es justo la prueba de vida.
 */
export const KEEPALIVE_MARGIN_MS = 25 * 60 * 60 * 1000;
/** Una fila 'pending' de más de dos días ya no la va a terminar nadie. */
export const PENDING_MAX_AGE_HOURS = 48;

/**
 * Lo que el job deja en la base sale de @mc/core (canales-textos.ts): las
 * mismas frases que escribe la web cuando el aviso de Unipile llega
 * primero. El código que marca una cuenta sin avisos es el de @mc/db
 * (CHANNEL_ERROR_CODES.webhooksMissing): la pantalla lo traduce.
 */
const WEBHOOKS_MISSING = CHANNEL_ERROR_CODES.webhooksMissing;
/** Una cuenta recién conectada tiene un momento sin avisos (la web los está dando de alta): no se toca. */
const WEBHOOKS_GRACE_MINUTES = 10;

const EMPTY_RELEASE: ReleaseResult = {
  released: 0, googleRevoked: 0, secretsPurged: 0, unipileAccountsDeleted: 0, unipileWebhooksDeleted: 0, sharedKept: 0, waitingForKeys: 0, failed: 0,
};

export interface KeepaliveDeps {
  /** Como mc_worker. */
  db: Queryable;
  /** El vault de tokens (EncryptedSecretStore en producción). */
  secrets: SecretStore;
  /** null = GOOGLE_CLIENT_ID/SECRET no están: los Gmail no se tocan. */
  google: Pick<GoogleOAuthApi, 'refresh' | 'revoke'> | null;
  /** null = UNIPILE_DSN/ACCESS_TOKEN no están: los LinkedIn e Instagram no se tocan. */
  unipile: Pick<UnipileApi, 'getAccount' | 'deleteAccount' | 'deleteWebhook' | 'createWebhook'> | null;
  /**
   * Con qué dar de alta los avisos de una cuenta que se quedó sin ellos:
   * el secreto compartido, la llave de ruta y la URL pública del webhook.
   * null = falta UNIPILE_WEBHOOK_SECRET, TOKEN_ENCRYPTION_KEY o APP_URL.
   */
  webhooks?: { secret: string; routeKey: Uint8Array; requestUrl: string } | null;
  now: Date;
  marginMs?: number;
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
  /** Fallos nuestros o transitorios: no cambian el estado de la cuenta. */
  failed: number;
  pendingRemoved: number;
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
}

/** `what` es una frase de CANALES_TEXTOS: va a last_error, y a la campana con su título y su llamada a la acción. */
async function markDown(db: Queryable, a: AccountRow, what: string, at: Date): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE outreach_channel_account SET status = 'needs_reconnect', last_error = $3, last_error_at = $4
      WHERE id = $1 AND workspace_id = $2 AND status IN ('connected', 'error') RETURNING id`,
    [a.id, a.workspace_id, what, at],
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

/**
 * Un fallo nuestro o pasajero: una frase fija en last_error. Nunca el
 * texto del proveedor (err.messageEs es su `detail` o su `message` tal
 * cual, en inglés): ese queda en api_call_log.error_message.
 */
async function noteFailure(db: Queryable, a: AccountRow, at: Date): Promise<void> {
  await db.query(
    `UPDATE outreach_channel_account SET last_error = $3, last_error_at = $4 WHERE id = $1 AND workspace_id = $2`,
    [a.id, a.workspace_id, CANALES_TEXTOS.transient, at],
  );
}

async function accounts(db: Queryable, provider: AccountRow['provider'], statuses: readonly string[]): Promise<AccountRow[]> {
  const { rows } = await db.query<AccountRow>(
    `SELECT id, workspace_id, channel, provider, provider_account_id, display_name, secret_ref, status
       FROM outreach_channel_account
      WHERE provider = $1 AND status = ANY($2::text[])
      ORDER BY id`,
    [provider, [...statuses]],
  );
  return rows;
}

/**
 * Las cuentas de Unipile conectadas sin sus dos avisos (y con unos minutos de
 * vida: a una recién conectada se los está dando de alta la web). Por
 * cada una, los dos avisos; si salen, sus ids a la fila y el código
 * `webhooks_missing` fuera; si no, el código se queda (o se pone) y
 * mañana se vuelve a intentar.
 */
async function restoreWebhooks(
  db: Queryable,
  unipile: Pick<UnipileApi, 'createWebhook'>,
  cfg: NonNullable<KeepaliveDeps['webhooks']>,
  now: Date,
): Promise<number> {
  const { rows } = await db.query<AccountRow>(
    `SELECT id, workspace_id, channel, provider, provider_account_id, display_name, secret_ref, status
       FROM outreach_channel_account
      WHERE provider = 'unipile' AND status = 'connected' AND cardinality(provider_webhook_ids) < $3
        AND provider_account_id NOT LIKE 'pending:%'
        AND updated_at < $1::timestamptz - make_interval(mins => $2)
      ORDER BY id`,
    [now, WEBHOOKS_GRACE_MINUTES, UNIPILE_ACCOUNT_WEBHOOK_SOURCES.length],
  );
  let restored = 0;
  for (const a of rows) {
    const { created, failed } = await registerAccountWebhooks({
      unipile, providerAccountId: a.provider_account_id, route: { workspaceId: a.workspace_id, channelAccountId: a.id },
      routeKey: cfg.routeKey, secret: cfg.secret, requestUrl: cfg.requestUrl, now,
    });
    await db.query(
      `UPDATE outreach_channel_account
          SET provider_webhook_ids = (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(provider_webhook_ids || $3::text[]) x),
              last_error = CASE WHEN $4 THEN $5 WHEN last_error = $5 THEN NULL ELSE last_error END,
              last_error_at = CASE WHEN $4 THEN $6::timestamptz WHEN last_error = $5 THEN NULL ELSE last_error_at END
        WHERE id = $1 AND workspace_id = $2 AND status = 'connected'`,
      [a.id, a.workspace_id, created, failed, WEBHOOKS_MISSING, now],
    );
    if (!failed) restored += 1;
  }
  return restored;
}

export async function runChannelsKeepalive(deps: KeepaliveDeps): Promise<KeepaliveResult> {
  const { db, now } = deps;
  const margin = deps.marginMs ?? KEEPALIVE_MARGIN_MS;
  const r: KeepaliveResult = {
    gmailRefreshed: 0, gmailUnchanged: 0, unipileChecked: 0, markedDown: 0, recovered: 0, webhooksRestored: 0, failed: 0,
    pendingRemoved: 0, release: EMPTY_RELEASE, skipped: { gmail: deps.google === null, unipile: deps.unipile === null },
  };

  // 1 · Gmail
  if (deps.google) {
    const google = deps.google;
    for (const a of await accounts(db, 'gmail_oauth', ['connected', 'error'])) {
      if (!a.secret_ref) {
        if (await markDown(db, a, CANALES_TEXTOS.gmailNoSecret, now)) r.markedDown += 1;
        continue;
      }
      let tokens: OAuthTokens | null;
      try {
        tokens = await deps.secrets.get(a.secret_ref);
      } catch {
        // No descifra: es nuestro (la clave), no de la persona. No se toca la cuenta.
        r.failed += 1;
        continue;
      }
      if (!tokens) {
        if (await markDown(db, a, CANALES_TEXTOS.gmailNoSecret, now)) r.markedDown += 1;
        continue;
      }
      try {
        const fresh = await freshGoogleTokens(tokens, now, (t) => google.refresh(t, { channelAccountId: a.id }), margin);
        if (!fresh.refreshed) {
          r.gmailUnchanged += 1;
          continue;
        }
        // Primero el vault (misma ref), después la fila: si el UPDATE falla, mañana se renueva con el token ya guardado.
        await deps.secrets.set(a.secret_ref, fresh.tokens);
        r.gmailRefreshed += 1;
        if (await markOk(db, a, now)) r.recovered += 1;
      } catch (err) {
        if (isOutreachApiError(err) && err.kind === 'not_connected') {
          if (await markDown(db, a, CANALES_TEXTOS.gmailRevoked, now)) r.markedDown += 1;
        } else {
          r.failed += 1;
          await noteFailure(db, a, now);
        }
      }
    }
  }

  // 2 · Avisos. Antes de comprobar las sesiones: esa comprobación toca updated_at, que es lo que dice qué cuenta
  // acaba de conectarse (y a cuál la web le está dando de alta los avisos ahora mismo).
  if (deps.unipile && deps.webhooks) r.webhooksRestored = await restoreWebhooks(db, deps.unipile, deps.webhooks, now);

  // 3 · Unipile
  if (deps.unipile) {
    for (const a of await accounts(db, 'unipile', ['connected', 'needs_reconnect', 'error'])) {
      r.unipileChecked += 1;
      try {
        const acc = await deps.unipile.getAccount(a.provider_account_id, { channelAccountId: a.id });
        if (acc.health === 'needs_reconnect') {
          if (await markDown(db, a, CANALES_TEXTOS.unipileStatus(acc.rawStatus, channelHealthName(a.channel)), now)) r.markedDown += 1;
        } else if (acc.health === 'ok' && (await markOk(db, a, now))) {
          r.recovered += 1;
        }
      } catch (err) {
        if (isOutreachApiError(err) && (err.kind === 'not_connected' || err.code === 'errors/resource_not_found')) {
          if (await markDown(db, a, CANALES_TEXTOS.unipileGone(channelHealthName(a.channel)), now)) r.markedDown += 1;
        } else {
          r.failed += 1;
          await noteFailure(db, a, now);
        }
      }
    }
  }

  // 4 · Limpieza
  const pend = await db.query(
    `DELETE FROM outreach_channel_account WHERE status = 'pending' AND updated_at < $1::timestamptz - make_interval(hours => $2) RETURNING id`,
    [now, PENDING_MAX_AGE_HOURS],
  );
  r.pendingRemoved = pend.rows.length;
  r.release = await runChannelsRelease({ db, secrets: deps.secrets, google: deps.google, unipile: deps.unipile, now });
  return r;
}

/** Lo que hace falta para dar de alta un aviso desde el worker; null si falta algo (se registra, no se inventa). */
export function webhookConfig(env: Readonly<Record<string, string | undefined>>): KeepaliveDeps['webhooks'] {
  const secret = env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim();
  const appUrl = env['APP_URL']?.trim().replace(/\/+$/, '');
  if (!secret || !appUrl) return null;
  try {
    return { secret, routeKey: channelSigningKeys(keyringFromEnv(env)).current.route, requestUrl: `${appUrl}/api/webhooks/unipile` };
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
      now: ctx.now(),
    });
    ctx.logger.info('keepalive de canales', { ...r });
    // Un fallo transitorio se reintenta mañana, con el cron: reintentar ya no ayuda.
    return { processed: r.gmailRefreshed + r.gmailUnchanged + r.unipileChecked, failed: r.failed + r.release.failed, metadata: { ...r }, retry: false };
  },
  { retryOnItemFailure: false },
);
