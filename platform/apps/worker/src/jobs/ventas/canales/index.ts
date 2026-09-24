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
 *                            la demo. Con NODE_ENV=production se IGNORA
 *                            (y se dice en el log): el canal falso marca
 *                            como enviados mensajes que nadie recibió y
 *                            avanza las cadencias reales (r2).
 *
 * `job:dispatch -- --canal-falso` no pasa por la variable: pide el modo
 * explícito, después de su propia guardia (correr-motor.ts).
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
import type { Env } from '../../../runner/config.ts';
import type { Logger } from '../../../runner/logger.ts';
import { fakeChannels } from './fake.ts';
import { GmailChannel } from './gmail.ts';
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

/** El modo que pide el entorno: el falso nunca en producción. */
export function channelModeFrom(env: Env, logger?: Pick<Logger, 'warn'>): 'real' | 'fake' {
  if (env['OUTREACH_CHANNELS'] !== 'fake') return 'real';
  if (env['NODE_ENV'] === 'production') {
    logger?.warn('OUTREACH_CHANNELS=fake se ignora en producción: el canal falso marcaría como enviados mensajes que nadie recibió.');
    return 'real';
  }
  return 'fake';
}

export interface BuildChannelsOptions {
  env: Env;
  secrets: SecretStore;
  /** La bitácora de las llamadas (api_call_log). Por defecto, ninguna. */
  callLog?: OutreachCallLogSink;
  fetch?: FetchLike;
  now?: () => Date;
  mode?: 'real' | 'fake';
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
  const mode = opts.mode ?? channelModeFrom(opts.env, opts.logger);
  const appUrl = appUrlFrom(opts.env);
  if (mode === 'fake') {
    const f = fakeChannels();
    return { mode, senders: f, readers: f, appUrl: appUrl ?? 'http://localhost:3100' };
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
    appUrl,
  };
}
