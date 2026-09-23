/**
 * Esquema Drizzle de las tablas y vistas del MVP.
 *
 * Lo que manda es db/migrations: este esquema se cura a mano a partir
 * de ellas y NUNCA genera migraciones (no hay drizzle-kit generate ni
 * push). La prueba test/schema.test.ts aplica las migraciones en
 * Postgres embebido y comprueba, columna por columna, que lo declarado
 * aquí coincide con la base: nombre, tipo, nulabilidad y default.
 *
 * Para curar una tabla nueva tras una migración:
 *   pnpm --filter @mc/db introspect     (drizzle-kit pull sobre pglite)
 * y copiar lo que haga falta al archivo del dominio, con el estilo de
 * los demás.
 *
 * Fuera del MVP (y por eso fuera de aquí): laboratorio de video (0005),
 * ideas y guiones (0006), radar externo (0004 salvo niche), reportes,
 * retención por plataforma (0011), reglas de semáforo (0012) y
 * benchmarks (0013).
 */
export * from './cimientos.ts';
export * from './conexiones.ts';
export * from './contenido.ts';
export * from './ventas.ts';
export * from './cotizar.ts';
export * from './campanas.ts';
export * from './finanzas.ts';
export * from './accesos.ts';
export * from './vistas.ts';
