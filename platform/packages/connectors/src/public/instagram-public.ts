/**
 * Instagram por @: business_discovery (CON-1) con el token de la cuenta
 * casa de On Cue (INSTAGRAM_HOUSE_TOKEN, larga duración, 60 días).
 * Lee cualquier cuenta PROFESIONAL y pública: seguidores y publicaciones.
 * Una cuenta personal devuelve code 100 (permanent) → not_discoverable.
 */
import type { HttpCore } from '../http/client.ts';
import { InstagramClient } from '../platforms/instagram-api.ts';
import type { OAuthTokens } from '../types.ts';
import { toLookupError } from './tiktok-public.ts';
import { assertHandle, PublicLookupError, type PublicProfile, type PublicProfileSource } from './types.ts';

export const INSTAGRAM_HOUSE_TOKEN_ENV = 'INSTAGRAM_HOUSE_TOKEN';
export const INSTAGRAM_METRICS_NOTE_ES = 'Instagram publica seguidores y número de publicaciones de las cuentas profesionales. Alcance, guardados y demografía requieren que el dueño autorice la cuenta.';

/**
 * El token de la cuenta profesional de On Cue, tal como lo quiere
 * `InstagramClient`. Sin vencimiento propio: Meta lo renueva por su
 * cuenta cada 60 días y aquí solo se usa, nunca se refresca.
 * Lo comparten la fuente de perfiles (CON-10) y la de posts (CON-5).
 */
export function instagramHouseTokens(env: Readonly<Record<string, string | undefined>>): OAuthTokens | null {
  const token = env[INSTAGRAM_HOUSE_TOKEN_ENV]?.trim();
  return token ? { accessToken: token, accessExpiresAt: new Date(8_640_000_000_000_000), scopes: ['instagram_business_basic'] } : null;
}

export function missingInstagramHouseToken(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return instagramHouseTokens(env) ? [] : [INSTAGRAM_HOUSE_TOKEN_ENV];
}

export const INSTAGRAM_HOUSE_TOKEN_MISSING_ES = `Falta ${INSTAGRAM_HOUSE_TOKEN_ENV}: el token de la cuenta profesional de On Cue con la que se leen las cuentas públicas.`;

export function createInstagramPublicSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PublicProfileSource {
  const house = instagramHouseTokens(env);
  return {
    platformId: 'instagram',
    label: 'Instagram (business_discovery)',
    missing: missingInstagramHouseToken(env),
    async lookup(handle, opts = {}) {
      const clean = assertHandle('instagram', handle);
      if (!house) throw new PublicLookupError('not_configured', INSTAGRAM_HOUSE_TOKEN_MISSING_ES);
      let res;
      try {
        res = await new InstagramClient(core, { connectionId: null, tokens: house }).businessDiscovery(clean, { signal: opts.signal });
      } catch (err) {
        throw toLookupError(err, clean, 'Instagram');
      }
      const d = res.data;
      if (!d.external_account_id) throw new PublicLookupError('not_discoverable', `Instagram no devolvió datos de @${clean}: solo las cuentas profesionales (creador o empresa) y públicas se pueden leer por @.`);
      const profile: PublicProfile = {
        platformId: 'instagram',
        profile: { external_account_id: d.external_account_id, handle: d.handle ?? clean, display_name: null, avatar_url: null, profile_url: `https://www.instagram.com/${d.handle ?? clean}/`, account_type: 'business' },
        metrics: { followers: d.followers_count, following: null, mediaCount: d.media_count, views: null },
        metricsNote: INSTAGRAM_METRICS_NOTE_ES,
        source: 'instagram.business_discovery',
        raw: res.raw,
      };
      return profile;
    },
  };
}
