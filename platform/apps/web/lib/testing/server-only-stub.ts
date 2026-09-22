/**
 * Sustituto de `server-only` para vitest. El paquete real lanza al
 * importarse fuera de un Server Component; en las pruebas de Node no hay
 * Server Components y lo que se prueba es la lógica, así que se vacía.
 * Lo enchufa vitest.config.ts por alias; Next nunca lo ve.
 */
export {};
