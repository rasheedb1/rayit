/**
 * Cadencias · las secuencias de outreach y su línea de tiempo (VEN-13).
 * Dueño: Rasheed. docs/ventas-outreach.md §5.3 y §5.5.
 *
 * Todo corre en un WorkspaceTx (mc_app, RLS del espacio de la
 * transacción): ninguna función recibe un workspace_id.
 *
 *   comun.ts      límites, CadenciaError, el bloqueo de una secuencia y la
 *                 regla de qué se puede editar con personas dentro
 *   lista.ts      /ventas/cadencias: secuencias con estado, enrolados y
 *                 respuesta contados en SQL; plantillas; señales que se
 *                 pueden proponer
 *   contexto.ts   a quién se le escribe: personas y direcciones, por qué
 *                 canales se les llega, en qué otra cadencia siguen vivas,
 *                 el creador del negocio y su brief, el contexto del
 *                 recomendador y los negocios para enrolar
 *   propuesta.ts  guardar una propuesta o una plantilla, reemplazar los
 *                 pasos de un borrador, registrar la llamada al modelo
 *   pasos.ts      leer la secuencia y sus pasos, escribirlos, y dejar el
 *                 hilo de correo y la guía en regla tras cada cambio
 *   edicion.ts    cambiar, añadir, quitar y reordenar pasos
 *   estado.ts     activar, pausar, archivar, duplicar, renombrar
 */
export * from './comun.ts';
export * from './lista.ts';
export * from './contexto.ts';
export * from './propuesta.ts';
export * from './pasos.ts';
export * from './edicion.ts';
export * from './estado.ts';
