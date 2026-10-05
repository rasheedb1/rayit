/**
 * El techo del arranque de cualquier archivo de pruebas que abre la base
 * embebida, en todos los paquetes (CIM-12). Sin imports: lo cargan la web
 * (apps/web/lib/testing/tiempos.ts) y test/pglite.ts sin arrastrar PGlite.
 *
 * Es un techo, no una espera: abrir la foto cuesta décimas. Es alto por
 * el peor caso legítimo, el primer proceso de la máquina después de
 * cambiar una migración, que construye la foto con la máquina cargada
 * mientras los demás esperan su candado (db/lib/foto.mjs). Un candado de
 * un proceso muerto ya no hace esperar: foto.mjs lo detecta por el pid.
 */
export const SETUP_TIMEOUT_MS = 900_000;
