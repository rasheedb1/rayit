/**
 * Cadencias · los límites de texto de una secuencia y sus pasos (VEN-13).
 *
 * Sin dependencias a propósito: los importan las consultas (que validan
 * en el servidor) y los formularios del navegador (maxLength), por la
 * ruta @mc/db/queries/cadencias-limites, para que un cambio aquí llegue
 * a los dos a la vez y el formulario nunca deje escribir de más.
 */
export const GUIDANCE_MAX = 1000;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const NAME_MAX = 120;
