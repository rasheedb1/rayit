/**
 * Qué adaptador atiende cada canal en esta corrida (VEN-10).
 *
 *   OUTREACH_CHANNELS=real   (por defecto) Gmail para el correo; Unipile
 *                            para LinkedIn e Instagram, si están
 *                            UNIPILE_DSN y UNIPILE_ACCESS_TOKEN.
 *   OUTREACH_CHANNELS=fake   el buzón en memoria para los tres: nada sale
 *                            de la máquina. Es lo que usan las pruebas y
 *                            la demo.
 *
 * El enlace de baja necesita la URL pública de la web (APP_URL, o la de
 * producción de Vercel). Sin ella el correo real no se reclama: un correo
 * sin enlace de baja válido no sale (0037 §4.5).
 */
import type { SecretStore } from '@mc/connectors';
import type { DispatchChannel } from '@mc/db/queries/outreach';
import type { Env } from '../../../runner/config.ts';
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

export function buildChannels(opts: { env: Env; secrets: SecretStore; fetch?: Fetch }): Channels {
  const mode = opts.env['OUTREACH_CHANNELS'] === 'fake' ? 'fake' : 'real';
  if (mode === 'fake') {
    const f = fakeChannels();
    return { mode, senders: f, readers: f, appUrl: appUrlFrom(opts.env) ?? 'http://localhost:3100' };
  }
  const gmail = new GmailChannel({
    secrets: opts.secrets, fetch: opts.fetch, clientId: opts.env['GOOGLE_CLIENT_ID'], clientSecret: opts.env['GOOGLE_CLIENT_SECRET'],
  });
  const unipile = { dsn: opts.env['UNIPILE_DSN'], accessToken: opts.env['UNIPILE_ACCESS_TOKEN'], fetch: opts.fetch };
  const linkedin = new UnipileChannel('linkedin', unipile);
  const instagram = new UnipileChannel('instagram_dm', unipile);
  return {
    mode,
    senders: { email: gmail, linkedin, instagram_dm: instagram },
    readers: { email: gmail, linkedin, instagram_dm: instagram },
    appUrl: appUrlFrom(opts.env),
  };
}
