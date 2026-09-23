export * from './types.ts';
export * from './instagram-posts.ts';
export * from './youtube-posts.ts';
export * from './tiktok-posts.ts';
export * from './authorized.ts';

import type { HttpCore } from '../http/client.ts';
import type { PlatformId } from '../types.ts';
import { createInstagramPublicPostSource } from './instagram-posts.ts';
import { createTikTokPublicPostSource } from './tiktok-posts.ts';
import type { PostSource } from './types.ts';
import { createYouTubePublicPostSource } from './youtube-posts.ts';

export type PostSources = Readonly<Partial<Record<PlatformId, PostSource>>>;

/**
 * Las fuentes de posts por @ (CON-5). Facebook no tiene camino en esta
 * versión; TikTok tiene fuente pero sin videos, para poder explicar por
 * qué en vez de dejar la cuenta en silencio.
 */
export function createPublicPostSources(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PostSources {
  return {
    tiktok: createTikTokPublicPostSource(),
    instagram: createInstagramPublicPostSource(core, env),
    youtube: createYouTubePublicPostSource(core, env),
  };
}
