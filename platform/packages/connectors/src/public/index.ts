export * from './types.ts';
export * from './tiktok-public.ts';
export * from './tiktok-aggregator.ts';
export * from './instagram-public.ts';
export * from './youtube-public.ts';
import type { HttpCore } from '../http/client.ts';
import type { PlatformId } from '../types.ts';
import { createInstagramPublicSource } from './instagram-public.ts';
import { createTikTokAggregatorSource } from './tiktok-aggregator.ts';
import { createTikTokPublicSource } from './tiktok-public.ts';
import type { PublicProfileSource } from './types.ts';
import { createYouTubePublicSource } from './youtube-public.ts';

export type PublicProfileSources = Readonly<Partial<Record<PlatformId, PublicProfileSource>>>;

/**
 * Las fuentes públicas por plataforma. Facebook no tiene camino en esta
 * versión.
 *
 * TikTok tiene dos: el proveedor de pago de CON-12 si está contratado
 * (seguidores y vistas), y si no el oEmbed de CON-10 (solo identidad).
 * La variable del proveedor ES el interruptor: sin ella, nada cambia y
 * nada sale a su red.
 */
export function createPublicProfileSources(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PublicProfileSources {
  return {
    tiktok: createTikTokAggregatorSource(core, env) ?? createTikTokPublicSource(core),
    instagram: createInstagramPublicSource(core, env),
    youtube: createYouTubePublicSource(core, env),
  };
}
