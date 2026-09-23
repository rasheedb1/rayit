/**
 * TikTok por @: identidad por oEmbed, el único endpoint público oficial.
 *
 *   GET https://www.tiktok.com/oembed?url=https://www.tiktok.com/@<handle>
 *   200 → { title, author_name, author_url, embed_product_id (= handle), embed_type: 'profile', … }
 *   400 → { message: 'Something went wrong', code: 400 } cuando el handle no existe
 *
 * Comprobado el 22-sep-2026 con una cuenta real. No trae seguidores ni
 * videos: las métricas quedan en null con la razón, hasta que se decida
 * la fuente (proveedor, CSV de TikTok Studio o autorización del dueño).
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import { asRecord, strOrNull } from '../normalize/values.ts';
import { assertHandle, PublicLookupError, type PublicProfile, type PublicProfileSource } from './types.ts';

export const TIKTOK_OEMBED_URL = 'https://www.tiktok.com/oembed';
export const TIKTOK_METRICS_NOTE_ES = 'TikTok no publica seguidores ni vistas por @ sin autorización del dueño. Por ahora solo confirmamos la cuenta; las métricas llegan con la fuente que se elija (proveedor o archivo de TikTok Studio).';

function parseOembedError(status: number, body: unknown): ParsedApiError | null {
  const b = asRecord(body);
  if (status >= 400) return { code: status === 400 || status === 404 ? 'not_found' : `http_${status}`, message: strOrNull(b['message']) ?? undefined };
  return null;
}

export function createTikTokPublicSource(core: HttpCore): PublicProfileSource {
  return {
    platformId: 'tiktok',
    label: 'oEmbed de TikTok',
    missing: [],
    accessMode: 'public_profile',
    async lookup(handle, opts = {}) {
      const clean = assertHandle('tiktok', handle);
      const profileUrl = `https://www.tiktok.com/@${clean}`;
      let res;
      try {
        res = await core.call<Record<string, unknown>>({
          platformId: 'tiktok', family: 'tiktok', endpoint: 'tiktok.oembed', method: 'GET', url: TIKTOK_OEMBED_URL, query: { url: profileUrl },
          connectionId: null, tokens: null, authStyle: 'none', parseError: parseOembedError, signal: opts.signal,
        });
      } catch (err) {
        throw toLookupError(err, clean, 'TikTok');
      }
      const uniqueId = strOrNull(res.body['embed_product_id']) ?? clean;
      const profile: PublicProfile = {
        platformId: 'tiktok',
        profile: { external_account_id: uniqueId, handle: uniqueId, display_name: strOrNull(res.body['author_name']), avatar_url: strOrNull(res.body['thumbnail_url']), profile_url: strOrNull(res.body['author_url']) ?? profileUrl, account_type: 'unknown' },
        metrics: null,
        metricsNote: TIKTOK_METRICS_NOTE_ES,
        source: 'tiktok.oembed',
        coverage: null,
        raw: res.body,
      };
      return profile;
    },
  };
}

/** Común a las tres fuentes: un PlatformApiError se traduce a lo que la pantalla puede decir. */
export function toLookupError(err: unknown, handle: string, platformName: string): PublicLookupError {
  if (err instanceof PublicLookupError) return err;
  const e = err as { kind?: string; code?: string; httpStatus?: number };
  if (e && typeof e === 'object' && 'kind' in e) {
    if (e.code === 'not_found' || e.httpStatus === 404) return new PublicLookupError('not_found', `No encontramos @${handle} en ${platformName}. Revisa que esté bien escrito y que la cuenta sea pública.`, { cause: err });
    if (e.kind === 'auth') return new PublicLookupError('not_configured', `La credencial de ${platformName} de On Cue venció o no es válida; hay que regenerarla.`, { cause: err });
    if (e.kind === 'permanent') return new PublicLookupError('not_discoverable', `${platformName} no permite leer @${handle} por este camino (cuenta personal, privada o inexistente).`, { cause: err });
    return new PublicLookupError('transient', `${platformName} no respondió; inténtalo de nuevo en unos minutos.`, { cause: err });
  }
  return new PublicLookupError('transient', `${platformName} no respondió; inténtalo de nuevo en unos minutos.`, { cause: err });
}
