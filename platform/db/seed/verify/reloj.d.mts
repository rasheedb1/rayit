/** Tipos de reloj.mjs para quien lo importa desde TypeScript (packages/db/src/embedded.ts). */

/** El SQL partido en código, literales, comentarios, identificadores y cuerpos $$…$$. */
export function trozos(sql: string): Array<{ tipo: 'codigo' | 'literal' | 'comentario' | 'identificador' | 'dolar'; texto: string }>;

/** El SQL con CURRENT_DATE y now() valiendo lo que valdrán dentro de `dias` días (negativo: antes). */
export function desplazarReloj(sql: string, dias: number, donde?: string): string;
