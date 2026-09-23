/**
 * YouTube por @: Data API v3 con la API key del proyecto (GOOGLE_API_KEY),
 * sin OAuth ni trámite. channels.list?forHandle da canal, suscriptores,
 * vistas acumuladas y número de videos (CON-1, channelByHandle).
 */
import type { HttpCore } from '../http/client.ts';
import { normalizeYouTubeChannel, YouTubeClient } from '../platforms/youtube-api.ts';
import { asArray, asRecord } from '../normalize/values.ts';
import { toLookupError } from './tiktok-public.ts';
import { assertHandle, PublicLookupError, type PublicProfile, type PublicProfileSource } from './types.ts';

export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY';
export const YOUTUBE_METRICS_NOTE_ES = 'YouTube publica suscriptores, vistas acumuladas y número de videos. Retención, tráfico y demografía requieren que el dueño autorice el canal.';

export function createYouTubePublicSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PublicProfileSource {
  const apiKey = env[GOOGLE_API_KEY_ENV]?.trim();
  return {
    platformId: 'youtube',
    label: 'YouTube Data API',
    missing: apiKey ? [] : [GOOGLE_API_KEY_ENV],
    async lookup(handle, opts = {}) {
      const clean = assertHandle('youtube', handle);
      if (!apiKey) throw new PublicLookupError('not_configured', `Falta ${GOOGLE_API_KEY_ENV}: la API key del proyecto de Google Cloud para leer canales públicos.`);
      let res;
      try {
        res = await new YouTubeClient(core, { connectionId: null, tokens: null }, { apiKey }).channelByHandle(clean, { signal: opts.signal });
      } catch (err) {
        throw toLookupError(err, clean, 'YouTube');
      }
      if (!res.data) throw new PublicLookupError('not_found', `No encontramos el canal @${clean} en YouTube. Revisa el handle (el que empieza por @ en la página del canal).`);
      const item = asArray(asRecord(res.raw)['items'])[0];
      const ch = normalizeYouTubeChannel(asRecord(item));
      const profile: PublicProfile = {
        platformId: 'youtube',
        profile: { ...ch.profile, handle: ch.profile.handle ?? clean },
        metrics: { followers: ch.metrics.followers, following: null, mediaCount: ch.metrics.media_count, views: ch.metrics.views },
        metricsNote: YOUTUBE_METRICS_NOTE_ES,
        source: 'youtube.channels.list',
        raw: res.raw,
      };
      return profile;
    },
  };
}
