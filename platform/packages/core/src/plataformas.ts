/**
 * Los nombres de marca de las cuatro redes y su orden de presentación.
 *
 * Un solo lugar: el kit de interfaz (components/ui/platform-pill.tsx) los
 * reexporta como PLATFORM_LABEL y el perfil comercial (VEN-11) los usa en
 * el prompt y en la narrativa de plantilla. Son nombres propios: no se
 * traducen, por eso pueden vivir en @mc/core y no en un messages.ts.
 *
 * Módulo sin dependencias de ejecución: lo importa un componente de
 * cliente sin arrastrar el resto de @mc/core.
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
