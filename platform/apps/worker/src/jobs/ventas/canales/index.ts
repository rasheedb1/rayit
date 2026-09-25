/**
 * Qué adaptador atiende cada canal en esta corrida (VEN-10).
 *
 *   OUTREACH_CHANNELS=real   (por defecto) los clientes de VEN-9
 *                            (@mc/connectors): Gmail para el correo si
 *                            están GOOGLE_CLIENT_ID/SECRET; Unipile para
 *                            LinkedIn e Instagram si están UNIPILE_DSN y
 *                            UNIPILE_ACCESS_TOKEN.
 *   OUTREACH_CHANNELS=fake   el buzón en memoria para los tres: nada sale
 *                            de la máquina. Es lo que usan las pruebas y
 *                            la demo.
 *
 * El canal falso deja como enviados mensajes que nadie recibió y avanza
 * las cadencias: solo se permite donde eso no engaña a nadie
 * (fakeAllowed, la ÚNICA regla, la misma para el worker programado y
 * para `job:dispatch -- --canal-falso`): Postgres embebido, una base de
 * esta máquina, o el workspace de la demo. Si se pide donde no se
 * permite (producción, o la base compartida de Supabase para todos los
 * workspaces), el worker no arranca (ConfigError), en vez de caer en
 * silencio al modo real o, peor, marcar como enviados los mensajes de
 * todas las creadoras.
 *
 * El enlace de baja necesita la URL pública de la web (APP_URL, o la de
 * producción de Vercel). Sin ella el correo real no se reclama: un correo
 * sin enlace de baja válido no sale (0037 §4.5).
 */
import {
  GoogleOAuth, loadGoogleOAuthConfig, loadUnipileConfig, NULL_OUTREACH_CALL_LOG, UnipileClient, type FetchLike,
  type OutreachCallLogSink, type SecretStore,
} from '@mc/connectors';
import type { DispatchChannel } from '@mc/db/queries/outreach';
import { ConfigError, type Env } from '../../../runner/config.ts';
import type { Logger } from '../../../runner/logger.ts';
import { DEMO_WORKSPACE_IDS } from '../demo-ids.ts';
import { fakeChannels } from './fake.ts';
import { GmailChannel } from './gmail.ts';
import type { MailboxFor } from '../outbound.bounces.ts';
import type { ChannelReader, ChannelSender } from './types.ts';
import { UnipileChannel } from './unipile.ts';

export type { ChannelReader, ChannelSender, OutgoingMessage, SendResult } from './types.ts';
export { FakeChannel, fakeChannels } from './fake.ts';
export { GmailChannel } from './gmail.ts';
export { UnipileChannel } from './unipile.ts';

export interface Channels {
  mode: 'real' | 'fake';
  senders: Partial<Record<DispatchChannel, ChannelSender>>;
  readers: Partial<Record<DispatchChannel, ChannelReader>>;
  /** El buzón de rebotes de cada cuenta de correo (outbound.bounces, VEN-15). null: canal no configurado. */
  bounces: MailboxFor;
  appUrl: string | null;
}

/** La URL pública de la web: APP_URL, o la de producción que pone Vercel. */
export function appUrlFrom(env: Env): string | null {
  const raw = env['APP_URL']?.trim() || (env['VERCEL_PROJECT_PRODUCTION_URL']?.trim() ? `https://${env['VERCEL_PROJECT_PRODUCTION_URL']!.trim()}` : '');
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** ¿La base es de esta máquina? (localhost, 127.0.0.1, ::1 o un socket). */
export function isLocalDatabase(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  } catch {
    return false;
  }
}

/** La base contra la que corre el motor: lo que decide si el canal falso se permite. */
export interface ChannelScope {
  /** La cadena de conexión del worker (WORKER_DATABASE_URL o DATABASE_URL_DIRECT). */
  databaseUrl: string | null | undefined;
  /** Postgres embebido (pglite): la base vive y muere con el proceso. */
  embedded?: boolean;
  /** Solo este workspace (la corrida a mano con --workspace). Sin él, todos. */
  workspaceId?: string;
}

/** La cadena de conexión del worker, con las mismas variables y el mismo orden que runner/config.ts. */
export function databaseUrlFrom(env: Env): string | null {
  return env['WORKER_DATABASE_URL'] || env['DATABASE_URL_DIRECT'] || null;
}

/**
 * ¿Puede correr el canal falso aquí? Solo si nadie real puede quedar
 * engañado: Postgres embebido, una base de esta máquina, o una corrida
 * limitada a un workspace de demostración (DEMO_WORKSPACE_IDS). La base
 * compartida para todos los workspaces, nunca.
 */
export function fakeAllowed(scope: ChannelScope): boolean {
  if (scope.embedded || isLocalDatabase(scope.databaseUrl)) return true;
  return scope.workspaceId !== undefined && (DEMO_WORKSPACE_IDS as readonly string[]).includes(scope.workspaceId);
}

/** Por qué no se permite el canal falso, dicho para quien arranca el worker. */
export function fakeRefusal(env: Env): string {
  return env['NODE_ENV'] === 'production'
    ? 'OUTREACH_CHANNELS=fake no se permite en producción: el canal falso marcaría como enviados mensajes que nadie recibió.'
    : 'El canal falso deja como enviados mensajes que nadie recibió y avanza las cadencias: contra una base que no es local, ' +
        `solo con --workspace de la demo (${DEMO_WORKSPACE_IDS.join(', ')}). Quita OUTREACH_CHANNELS=fake o usa --pglite.`;
}

/**
 * El modo que pide el entorno. El falso solo donde fakeAllowed lo deja,
 * y nunca con NODE_ENV=production; si no, ConfigError: el worker no
 * arranca y el job falla con el motivo.
 */
export function channelModeFrom(env: Env, scope: ChannelScope): 'real' | 'fake' {
  if (env['OUTREACH_CHANNELS'] !== 'fake') return 'real';
  if (env['NODE_ENV'] === 'production' || !fakeAllowed(scope)) throw new ConfigError(fakeRefusal(env));
  return 'fake';
}

/** El alcance de un job programado: la base del worker, para todos los workspaces. */
export function jobScope(ctx: { env: Env; db: object }): ChannelScope {
  return { databaseUrl: databaseUrlFrom(ctx.env), embedded: 'kind' in ctx.db && ctx.db.kind === 'pglite' };
}

export interface BuildChannelsOptions {
  env: Env;
  secrets: SecretStore;
  /** La bitácora de las llamadas (api_call_log). Por defecto, ninguna. */
  callLog?: OutreachCallLogSink;
  fetch?: FetchLike;
  now?: () => Date;
  /** El modo, ya decidido por quien llama (job:dispatch, después de su guardia). Sin él, channelModeFrom(env, scope). */
  mode?: 'real' | 'fake';
  /** La base contra la que corre (ver fakeAllowed). Por defecto, la del entorno, para todos los workspaces. */
  scope?: ChannelScope;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Los adaptadores de esta corrida. En modo real, sobre los clientes de
 * VEN-9 (@mc/connectors) con las llaves de la plataforma: el correo
 * necesita GOOGLE_CLIENT_ID/SECRET para renovar tokens, y LinkedIn e
 * Instagram, UNIPILE_DSN y UNIPILE_ACCESS_TOKEN. Lo que falte deja su
 * canal «no configurado» (configured() = false): sus toques esperan.
 */
export function buildChannels(opts: BuildChannelsOptions): Channels {
  const mode = opts.mode ?? channelModeFrom(opts.env, opts.scope ?? { databaseUrl: databaseUrlFrom(opts.env) });
  const appUrl = appUrlFrom(opts.env);
  if (mode === 'fake') {
    const f = fakeChannels();
    // El canal falso no tiene buzón: los rebotes del modo falso no existen.
    return { mode, senders: f, readers: f, bounces: () => null, appUrl: appUrl ?? 'http://localhost:3100' };
  }
  const callLog = opts.callLog ?? NULL_OUTREACH_CALL_LOG;
  const http = { callLog, fetch: opts.fetch, now: opts.now, retry: { maxRetries: 0 } };
  const google = loadGoogleOAuthConfig(opts.env, appUrl);
  const unipile = loadUnipileConfig(opts.env);
  const logger = opts.logger ? { warn: (msg: string, meta?: Record<string, unknown>) => opts.logger!.warn(msg, meta) } : undefined;
  const gmail = new GmailChannel({
    secrets: opts.secrets, oauth: 'config' in google ? new GoogleOAuth(google.config, http) : null,
    callLog, fetch: opts.fetch, now: opts.now, logger,
  });
  const api = 'config' in unipile ? new UnipileClient({ config: unipile.config, ...http }) : null;
  const linkedin = new UnipileChannel('linkedin', { api, logger });
  const instagram = new UnipileChannel('instagram_dm', { api, logger });
  return {
    mode,
    senders: { email: gmail, linkedin, instagram_dm: instagram },
    readers: { email: gmail, linkedin, instagram_dm: instagram },
    bounces: (account) => gmail.bounceMailboxFor(account),
    appUrl,
  };
}
