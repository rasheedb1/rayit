/**
 * Los nombres de marca de las cuatro redes y su orden de presentación.
 *
 * Los usa el perfil comercial (VEN-11) en el prompt y en la narrativa de
 * plantilla, que viven en @mc/core y no pueden importar la web. Son
 * nombres propios: no se traducen, por eso pueden vivir aquí y no en un
 * messages.ts. La pantalla sigue usando PLATFORM_LABEL del kit
 * (components/ui/platform-pill.tsx), que es de Nicolás y no se toca:
 * unificar las dos listas en una sola fuente queda propuesto para un PR
 * aparte que él revise (nota de VEN-11 en el backlog).
 */
import type { PlatformId } from './campanas.ts';

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
};

/** El orden en que se enseñan las redes cuando no hay otro criterio. */
export const PLATFORM_ORDER: readonly PlatformId[] = ['tiktok', 'instagram', 'facebook', 'youtube'];
