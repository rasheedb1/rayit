/**
 * Las redes y los periodos del módulo Resumen, y sus validaciones.
 *
 * Van aparte de `resumen.ts` a propósito: este archivo no importa NADA,
 * así que los componentes cliente de la web (el filtro, el asistente de
 * importación) pueden usar estos valores sin que el empaquetador meta
 * en el navegador el cliente de Postgres que `resumen.ts` sí necesita.
 * `resumen.ts` los reexporta: en el servidor da igual de dónde se tomen.
 */

/** platform.id (catálogo de 0002). Las cuatro redes del MVP. */
export type PlatformId = 'tiktok' | 'instagram' | 'facebook' | 'youtube';

export const PLATFORMS: readonly PlatformId[] = ['tiktok', 'instagram', 'facebook', 'youtube'];

/** Los tres periodos que ofrece la pantalla. Van en la URL, así que se validan. */
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

export function assertPeriod(days: number): asserts days is Period {
  if (!(PERIODS as readonly number[]).includes(days)) {
    throw new Error(`periodo inválido: ${String(days)}. Uno de ${PERIODS.join(', ')}.`);
  }
}

export function assertPlatform(platform: string | null | undefined): asserts platform is PlatformId | null | undefined {
  if (platform !== null && platform !== undefined && !PLATFORMS.includes(platform as PlatformId)) {
    throw new Error(`red inválida: "${platform}". Una de ${PLATFORMS.join(', ')}.`);
  }
}
