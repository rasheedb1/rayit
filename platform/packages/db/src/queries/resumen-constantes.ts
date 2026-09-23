/**
 * Las redes y los periodos del módulo Resumen, y sus validaciones.
 *
 * Van aparte de `resumen.ts` a propósito: este archivo no importa NADA,
 * así que los componentes cliente de la web (el filtro, el asistente de
 * importación) pueden usar estos valores sin que el empaquetador meta
 * en el navegador el cliente de Postgres que `resumen.ts` sí necesita.
 * `resumen.ts` los reexporta: en el servidor da igual de dónde se tomen.
 */

/**
 * platform.id (catálogo de 0002). Las cuatro redes del MVP.
 *
 * Es una tupla NO vacía y de solo lectura (`as const`), así que
 * `z.enum(PLATFORMS)` la toma tal cual en la frontera de validación, sin
 * forzar el tipo. PlatformId sale de ella: una red nueva se agrega en un
 * solo sitio y no hay forma de que el tipo y la lista se separen.
 */
export const PLATFORMS = ['tiktok', 'instagram', 'facebook', 'youtube'] as const;
export type PlatformId = (typeof PLATFORMS)[number];

/** Los tres periodos que ofrece la pantalla. Van en la URL, así que se validan. */
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

/**
 * Cuántas semanas enseña el gráfico de visualizaciones. Es fijo y NO
 * depende del periodo del filtro: la historia (RES-1, RES-5) y el mock
 * piden «views por semana y red en 12 semanas».
 */
export const VIEWS_WEEKS = 12;

/**
 * Por debajo de esto, un KPI de contenido (alcance en no seguidores,
 * guardados por mil) no se compara contra el periodo anterior: una
 * flecha roja de «−50 %» calculada sobre UN video es ruido que alarma.
 * Se exige en los DOS periodos. La cifra se sigue enseñando.
 */
export const MIN_SAMPLE = 3;

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
