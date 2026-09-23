/**
 * Instagram por @: business_discovery (CON-1) con el token de la cuenta
 * casa de On Cue (INSTAGRAM_HOUSE_TOKEN, larga duración, 60 días).
 * Lee cualquier cuenta PROFESIONAL y pública: seguidores y publicaciones.
 * Una cuenta personal devuelve code 100 (permanent) → not_discoverable.
 */
import type { HttpCore } from '../http/client.ts';
import { isPlatformApiError } from '../http/errors.ts';
import { InstagramClient } from '../platforms/instagram-api.ts';
import type { OAuthTokens } from '../types.ts';
import { toLookupError } from './tiktok-public.ts';
import { assertHandle, PublicLookupError, type PublicProfile, type PublicProfileSource } from './types.ts';

/** Meta, business_discovery: «Could not find the user» (fixtures/instagram/business_discovery.not_found.json). */
export const META_USER_NOT_FOUND_CODE = '110';

export const INSTAGRAM_HOUSE_TOKEN_ENV = 'INSTAGRAM_HOUSE_TOKEN';
export const INSTAGRAM_METRICS_NOTE_ES = 'Instagram publica seguidores y número de publicaciones de las cuentas profesionales. Alcance, guardados y demografía requieren que el dueño autorice la cuenta.';

export function createInstagramPublicSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PublicProfileSource {
  const token = env[INSTAGRAM_HOUSE_TOKEN_ENV]?.trim();
  const house: OAuthTokens | null = token ? { accessToken: token, accessExpiresAt: new Date(8_640_000_000_000_000), scopes: ['instagram_business_basic'] } : null;
  return {
    platformId: 'instagram',
    label: 'Instagram (business_discovery)',
    missing: house ? [] : [INSTAGRAM_HOUSE_TOKEN_ENV],
    accessMode: 'public_profile',
    async lookup(handle, opts = {}) {
      const clean = assertHandle('instagram', handle);
      if (!house) throw new PublicLookupError('not_configured', `Falta ${INSTAGRAM_HOUSE_TOKEN_ENV}: el token de la cuenta profesional de On Cue con la que se leen las cuentas públicas.`);
      let res;
      try {
        res = await new InstagramClient(core, { connectionId: null, tokens: house }).businessDiscovery(clean, { signal: opts.signal });
      } catch (err) {
        // Meta separa «no existe» (110, subcódigo 2207013) de «personal o privada» (100):
        // el primero es un @ mal escrito y la pantalla lo dice así (CAM-3).
        if (isPlatformApiError(err) && err.code === META_USER_NOT_FOUND_CODE) {
          throw new PublicLookupError('not_found', `No encontramos @${clean} en Instagram. Revisa que esté bien escrito y que la cuenta sea pública.`, { cause: err });
        }
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
        coverage: null,
        raw: res.raw,
      };
      return profile;
    },
  };
}
