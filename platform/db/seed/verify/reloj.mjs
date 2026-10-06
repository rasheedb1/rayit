/**
 * El reloj de la verificación vive en db/lib/reloj.mjs desde CIM-12 (r3):
 * lo usan también el Postgres embebido de las pruebas (packages/db) y el
 * arnés del worker, y db/seed/verify es la herramienta de `make
 * db.seed.check`, no una biblioteca. Se reexporta aquí para quien ya lo
 * importaba de esta ruta (run.mjs, las pruebas de @mc/core).
 */
export { desplazarReloj, trozos } from '../../lib/reloj.mjs';
