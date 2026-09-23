/**
 * Los textos de interfaz de la ruta genérica del plan de construcción,
 * en un solo archivo como los de cada módulo. El nombre del módulo llega
 * de `content/modules.ts`.
 */
export const MESSAGES = {
  /** El título de la pestaña del navegador: «Plan · Resumen». */
  metaTitle: (modulo: string) => `Plan · ${modulo}`,
} as const;
