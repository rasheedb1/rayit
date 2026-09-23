/**
 * Todos los jobs que conoce el worker. Cada módulo exporta los suyos
 * desde su carpeta y aquí se suman: es la única línea que un módulo
 * nuevo tiene que tocar fuera de su carpeta.
 *
 *   import { ventasJobs } from './ventas/index.ts';       // Rasheed (VEN-4)
 *   import { finanzasJobs } from './finanzas/index.ts';   // Nicolás (FIN-4)
 *   import { campanasJobs } from './campanas/index.ts';   // Nicolás (CAM-3, CAM-5)
 */
import { campanasJobs } from './campanas/index.ts';
import { conexionesJobs } from './conexiones/index.ts';
import type { JobRegistration } from '../runner/registry.ts';

export const allJobs: readonly JobRegistration[] = [...conexionesJobs, ...campanasJobs];
