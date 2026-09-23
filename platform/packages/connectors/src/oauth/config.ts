/**
 * Qué app está configurada, leyendo SOLO nombres de variables. Los
 * valores nunca se imprimen: `missing` lista las variables que faltan
 * para que la pantalla y el worker digan exactamente qué hay que meter
 * al vault.
 */
import type { OAuthAppConfig, OAuthProviderId } from './types.ts';
import { YOUTUBE_OAUTH_SCOPES } from './google.ts';
import { INSTAGRAM_LOGIN_SCOPES } from './instagram-login.ts';
import { TIKTOK_BUSINESS_SCOPES } from './tiktok-business.ts';
import { TIKTOK_LOGIN_SCOPES } from './tiktok-login.ts';

export interface OAuthEnvNames {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Los nombres de .env.example. */
export const OAUTH_ENV_NAMES: Readonly<Record<OAuthProviderId, OAuthEnvNames>> = {
  tiktok: { clientId: 'TIKTOK_LOGIN_CLIENT_KEY', clientSecret: 'TIKTOK_LOGIN_CLIENT_SECRET', redirectUri: 'TIKTOK_LOGIN_REDIRECT_URI' },
  'tiktok-business': { clientId: 'TIKTOK_BUSINESS_APP_ID', clientSecret: 'TIKTOK_BUSINESS_APP_SECRET', redirectUri: 'TIKTOK_BUSINESS_REDIRECT_URI' },
  instagram: { clientId: 'META_APP_ID', clientSecret: 'META_APP_SECRET', redirectUri: 'META_REDIRECT_URI' },
  youtube: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', redirectUri: 'GOOGLE_REDIRECT_URI' },
};

const DEFAULT_SCOPES: Readonly<Record<OAuthProviderId, readonly string[]>> = {
  tiktok: TIKTOK_LOGIN_SCOPES,
  'tiktok-business': TIKTOK_BUSINESS_SCOPES,
  instagram: INSTAGRAM_LOGIN_SCOPES,
  youtube: YOUTUBE_OAUTH_SCOPES,
};

/** Ruta del callback en la web; con APP_URL delante es la redirect URI a registrar si no se fija la variable. */
export function callbackPath(provider: OAuthProviderId): string {
  return `/conexiones/oauth/${provider}/callback`;
}

export interface OAuthApps {
  apps: Partial<Record<OAuthProviderId, OAuthAppConfig>>;
  /** Por proveedor no configurado, las variables que faltan. */
  missing: Partial<Record<OAuthProviderId, string[]>>;
}

export function loadOAuthApps(env: Readonly<Record<string, string | undefined>>): OAuthApps {
  const apps: OAuthApps['apps'] = {};
  const missing: OAuthApps['missing'] = {};
  const appUrl = env['APP_URL']?.trim().replace(/\/$/, '');
  for (const provider of Object.keys(OAUTH_ENV_NAMES) as OAuthProviderId[]) {
    const names = OAUTH_ENV_NAMES[provider];
    const clientId = env[names.clientId]?.trim();
    const clientSecret = env[names.clientSecret]?.trim();
    const redirectUri = env[names.redirectUri]?.trim() || (appUrl ? `${appUrl}${callbackPath(provider)}` : undefined);
    const lacking: string[] = [];
    if (!clientId) lacking.push(names.clientId);
    if (!clientSecret) lacking.push(names.clientSecret);
    if (!redirectUri) lacking.push(`${names.redirectUri} (o APP_URL)`);
    if (lacking.length > 0 || !clientId || !clientSecret || !redirectUri) {
      missing[provider] = lacking;
      continue;
    }
    apps[provider] = { provider, clientId, clientSecret, redirectUri, scopes: DEFAULT_SCOPES[provider] };
  }
  return { apps, missing };
}
