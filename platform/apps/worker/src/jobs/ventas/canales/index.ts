/**
 * Qué adaptador atiende cada canal en esta corrida (VEN-10).
 *
 *   OUTREACH_CHANNELS=real   (por defecto) Gmail para el correo; Unipile
 *                            para LinkedIn e Instagram, si están
 *                            UNIPILE_DSN y UNIPILE_ACCESS_TOKEN.
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
 *
 * Y necesita que la página exista (r2). Cada correo real lleva en el pie
 * y en List-Unsubscribe (con List-Unsubscribe-Post de un clic, RFC 8058)
 * un enlace a {APP_URL}/baja/<token>; esa página, con su GET de
 * confirmación y su POST de un clic, es de VEN-15. Mientras no esté, el
 * enlace daría 404 y el botón de baja de Gmail haría POST a la nada: un
 * correo comercial sin baja que funcione (CAN-SPAM, y la regla de 2024 de
 * Gmail y Yahoo). Por eso, en modo real, el correo solo se reclama con
 * OUTREACH_OPTOUT_PAGE_READY=true, que se enciende al desplegar VEN-15.
 * LinkedIn e Instagram no llevan enlace de baja y no esperan a nada.
 */
import type { SecretStore } from '@mc/connectors';
import type { DispatchChannel } from '@mc/db/queries/outreach';
import type { Env } from '../../../runner/config.ts';
import type { Logger } from '../../../runner/logger.ts';
import { fakeChannels } from './fake.ts';
import { GmailChannel } from './gmail.ts';
import type { ChannelReader, ChannelSender, Fetch } from './types.ts';
import { UnipileChannel } from './unipile.ts';

export type { ChannelReader, ChannelSender, OutgoingMessage, SendResult } from './types.ts';
export { FakeChannel, fakeChannels } from './fake.ts';
export { GmailChannel } from './gmail.ts';
export { UnipileChannel } from './unipile.ts';

export interface Channels {
  mode: 'real' | 'fake';
  senders: Partial<Record<DispatchChannel, ChannelSender>>;
  readers: Partial<Record<DispatchChannel, ChannelReader>>;
  /** La base del enlace de baja. null = el correo no se reclama (ver emailBlocked). */
  appUrl: string | null;
  /** Por qué el correo real no sale en esta corrida (sin URL pública, o sin la página de baja), o null. */
  emailBlocked: string | null;
}

/** ¿La página de baja (/baja/<token>, GET y POST de un clic) está desplegada? La enciende VEN-15. */
export function optoutPageReady(env: Env): boolean {
  return env['OUTREACH_OPTOUT_PAGE_READY']?.trim().toLowerCase() === 'true';
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

export function buildChannels(opts: { env: Env; secrets: SecretStore; fetch?: Fetch; mode?: 'real' | 'fake'; logger?: Pick<Logger, 'warn'> }): Channels {
  const mode = opts.mode ?? channelModeFrom(opts.env, opts.logger);
  if (mode === 'fake') {
    // El buzón falso no entrega nada a nadie: el enlace no tiene que funcionar.
    const f = fakeChannels();
    return { mode, senders: f, readers: f, appUrl: appUrlFrom(opts.env) ?? 'http://localhost:3100', emailBlocked: null };
  }
  const gmail = new GmailChannel({
    secrets: opts.secrets, fetch: opts.fetch, clientId: opts.env['GOOGLE_CLIENT_ID'], clientSecret: opts.env['GOOGLE_CLIENT_SECRET'],
  });
  const unipile = { dsn: opts.env['UNIPILE_DSN'], accessToken: opts.env['UNIPILE_ACCESS_TOKEN'], fetch: opts.fetch };
  const linkedin = new UnipileChannel('linkedin', unipile);
  const instagram = new UnipileChannel('instagram_dm', unipile);
  const url = appUrlFrom(opts.env);
  const pageReady = optoutPageReady(opts.env);
  const emailBlocked = !url
    ? 'Falta APP_URL (o VERCEL_PROJECT_PRODUCTION_URL): sin ella no hay enlace de baja.'
    : !pageReady
      ? 'OUTREACH_OPTOUT_PAGE_READY no está en true: la página de baja (/baja, VEN-15) todavía no existe.'
      : null;
  return {
    mode,
    senders: { email: gmail, linkedin, instagram_dm: instagram },
    readers: { email: gmail, linkedin, instagram_dm: instagram },
    appUrl: emailBlocked ? null : url,
    emailBlocked,
  };
}
