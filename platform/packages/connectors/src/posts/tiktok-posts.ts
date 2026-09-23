/**
 * TikTok por @ (CON-5): no hay fuente de posts.
 *
 * Lo comprobado el 22-sep-2026 y escrito en docs/propuestas/CON-10.md
 * §0.1 sigue valiendo: el único endpoint público oficial es oEmbed, que
 * confirma la identidad de la cuenta y nada más. El HTML público falla
 * desde servidor (SlardarWAF) y va contra los términos.
 *
 * Así que esta fuente existe para poder DECIRLO: no lista posts, no
 * falla, y el job anota la cuenta con esta razón en su metadata. Los
 * videos de TikTok entran por el archivo de TikTok Studio que sube el
 * creador (RES-2, `source = 'csv_import'`), o autorizando la cuenta
 * (CON-3, la estrategia autorizada de posts/authorized.ts).
 */
import type { NormalizedVideo } from '../normalize/types.ts';
import { EMPTY_METRICS_RESULT, type PostMetricsResult, type PostSource } from './types.ts';

export const TIKTOK_POSTS_NOTE_ES =
  'TikTok no publica los videos de una cuenta por @ sin autorización del dueño. Los de esta cuenta entran por el archivo de TikTok Studio, o autorizando la cuenta.';

export function createTikTokPublicPostSource(): PostSource {
  return {
    platformId: 'tiktok',
    label: 'TikTok (sin fuente pública de videos)',
    missing: [],
    supportsLookupById: false,
    noPostsNoteEs: TIKTOK_POSTS_NOTE_ES,
    // El contrato es un AsyncIterable; aquí simplemente no hay nada que entregar.
    async *listRecentPosts(): AsyncIterable<NormalizedVideo> {
      // Sin yield: la cuenta queda anotada, no falla.
    },
    postMetrics(): Promise<PostMetricsResult> {
      return Promise.resolve(EMPTY_METRICS_RESULT);
    },
  };
}
