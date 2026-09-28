/**
 * Instagram por @: business_discovery (CON-1) con el token de la cuenta
 * casa de On Cue (INSTAGRAM_HOUSE_TOKEN, larga duración, 60 días).
 * Lee cualquier cuenta PROFESIONAL y pública: seguidores y publicaciones.
 * Una cuenta personal devuelve code 100 (permanent) → not_discoverable.
 */
import type { HttpCore } from '../http/client.ts';
import { isPlatformApiError } from '../http/errors.ts';
import { FACEBOOK_GRAPH_BASE_URL, INSTAGRAM_NO_DISCOVERY_CODE, InstagramClient, type InstagramOptions } from '../platforms/instagram-api.ts';
import type { OAuthTokens } from '../types.ts';
import { toLookupError } from './tiktok-public.ts';
import { assertHandle, PublicLookupError, type PublicProfile, type PublicProfileSource } from './types.ts';

/** Meta, business_discovery: «Could not find the user» (fixtures/instagram/business_discovery.not_found.json). */
export const META_USER_NOT_FOUND_CODE = '110';

export const INSTAGRAM_HOUSE_TOKEN_ENV = 'INSTAGRAM_HOUSE_TOKEN';
/**
 * Id de la cuenta profesional de On Cue en la Graph API de Facebook
 * (17841…). Con él, business_discovery va por Facebook Login
 * (graph.facebook.com/{id}) y el token casa es un token de Facebook
 * (EAA…) con instagram_basic y pages_show_list. Sin él, por Instagram
 * Login (graph.instagram.com/me), donde Meta NO expone business_discovery.
 */
export const INSTAGRAM_HOUSE_IG_USER_ID_ENV = 'INSTAGRAM_HOUSE_IG_USER_ID';
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

/** Host y nodo de business_discovery según el tipo de token casa. */
export function instagramHouseClientOptions(env: Readonly<Record<string, string | undefined>>): InstagramOptions {
  const igUserId = env[INSTAGRAM_HOUSE_IG_USER_ID_ENV]?.trim();
  return igUserId ? { baseUrl: FACEBOOK_GRAPH_BASE_URL, discoveryNode: igUserId } : {};
}

export function missingInstagramHouseToken(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const token = instagramHouseTokens(env)?.accessToken;
  if (!token) return [INSTAGRAM_HOUSE_TOKEN_ENV];
  // Un token de Facebook (EAA…) solo sirve con el id de la cuenta: sin él iría a graph.instagram.com y fallaría.
  if (token.startsWith('EAA') && !env[INSTAGRAM_HOUSE_IG_USER_ID_ENV]?.trim()) return [INSTAGRAM_HOUSE_IG_USER_ID_ENV];
  return [];
}

/** La respuesta de Meta cuando el token casa es de Instagram Login: el campo no existe en ese host. */
export function isDiscoveryUnavailable(err: unknown): boolean {
  return isPlatformApiError(err) && err.code === INSTAGRAM_NO_DISCOVERY_CODE;
}

export const INSTAGRAM_DISCOVERY_UNAVAILABLE_ES = `El token de Instagram de On Cue es de «Instagram Login», y con ese tipo de token Meta no deja leer otras cuentas por @. Hace falta un token de Facebook Login y ${INSTAGRAM_HOUSE_IG_USER_ID_ENV} (docs/propuestas/CON-10.md §3).`;

export const INSTAGRAM_HOUSE_TOKEN_MISSING_ES = `Falta ${INSTAGRAM_HOUSE_TOKEN_ENV}: el token de la cuenta profesional de On Cue con la que se leen las cuentas públicas.`;
export const INSTAGRAM_HOUSE_IG_USER_ID_MISSING_ES = `Falta ${INSTAGRAM_HOUSE_IG_USER_ID_ENV}: el token de Instagram de On Cue es de Facebook y necesita el id de su cuenta profesional.`;

export function createInstagramPublicSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PublicProfileSource {
  const house = instagramHouseTokens(env);
  const missing = missingInstagramHouseToken(env);
  const clientOpts = instagramHouseClientOptions(env);
  return {
    platformId: 'instagram',
    label: 'Instagram (business_discovery)',
    missing,
    accessMode: 'public_profile',
    async lookup(handle, opts = {}) {
      const clean = assertHandle('instagram', handle);
      if (!house) throw new PublicLookupError('not_configured', INSTAGRAM_HOUSE_TOKEN_MISSING_ES);
      if (missing.length > 0) throw new PublicLookupError('not_configured', INSTAGRAM_HOUSE_IG_USER_ID_MISSING_ES);
      let res;
      try {
        res = await new InstagramClient(core, { connectionId: null, tokens: house }, clientOpts).businessDiscovery(clean, { signal: opts.signal });
      } catch (err) {
        if (isDiscoveryUnavailable(err)) throw new PublicLookupError('not_configured', INSTAGRAM_DISCOVERY_UNAVAILABLE_ES, { cause: err });
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
        raw: res.raw,
      };
      return profile;
    },
  };
}
