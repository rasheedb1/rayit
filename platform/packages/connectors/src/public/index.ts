export * from './types.ts';
export * from './tiktok-public.ts';
export * from './instagram-public.ts';
export * from './youtube-public.ts';
import type { HttpCore } from '../http/client.ts';
import type { PlatformId } from '../types.ts';
import { createInstagramPublicSource } from './instagram-public.ts';
import { createTikTokPublicSource } from './tiktok-public.ts';
import type { PublicProfileSource } from './types.ts';
import { createYouTubePublicSource } from './youtube-public.ts';

export type PublicProfileSources = Readonly<Partial<Record<PlatformId, PublicProfileSource>>>;

/** Las fuentes públicas por plataforma. Facebook no tiene camino en esta versión. */
export function createPublicProfileSources(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PublicProfileSources {
  return {
    tiktok: createTikTokPublicSource(core),
    instagram: createInstagramPublicSource(core, env),
    youtube: createYouTubePublicSource(core, env),
  };
}
