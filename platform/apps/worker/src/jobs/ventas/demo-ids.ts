/**
 * Los workspaces de demostración del seed: los únicos donde el canal
 * falso puede correr contra una base compartida (canales/index.ts,
 * fakeAllowed). Viven aparte para que el worker los lea sin cargar la
 * demo (demo-motor.ts, que trae Postgres embebido).
 */

/** El workspace de la demo (Laura · Cocina fácil), el del seed 0002. */
export const DEMO_WORKSPACE_ID = '00000002-0000-4000-8000-000000000001';
/** Los workspaces de demostración. */
export const DEMO_WORKSPACE_IDS = [DEMO_WORKSPACE_ID] as const;
