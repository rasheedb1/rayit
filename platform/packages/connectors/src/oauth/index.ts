export * from './types.ts';
export * from './config.ts';
export * from './errors.ts';
export * from './tiktok-login.ts';
export * from './tiktok-business.ts';
export * from './instagram-login.ts';
export * from './google.ts';
import { youtubeOAuthProvider } from './google.ts';
import { instagramLoginProvider } from './instagram-login.ts';
import { tiktokBusinessProvider } from './tiktok-business.ts';
import { tiktokLoginProvider } from './tiktok-login.ts';
import type { OAuthProvider, OAuthProviderId } from './types.ts';

/** Los cuatro proveedores por id, para las rutas de la web y los refreshers. */
export const OAUTH_PROVIDERS: Readonly<Record<OAuthProviderId, OAuthProvider>> = {
  tiktok: tiktokLoginProvider,
  'tiktok-business': tiktokBusinessProvider,
  instagram: instagramLoginProvider,
  youtube: youtubeOAuthProvider,
};
