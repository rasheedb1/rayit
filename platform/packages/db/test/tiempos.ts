/**
 * El techo del arranque de cualquier archivo de pruebas que abre la base
 * embebida, en todos los paquetes (CIM-12). Sin imports: lo cargan la web
 * (apps/web/lib/testing/tiempos.ts), el arnés del worker y test/pglite.ts
 * sin arrastrar PGlite.
 *
 * Es un techo, no una espera: abrir la foto cuesta décimas. Sale de lo
 * medido, no de «lo más alto que había» (r3, 5-oct): el peor caso
 * legítimo es el primer proceso de la máquina después de cambiar una
 * migración, que construye la foto (77 migraciones) y siembra la demo con
 * la máquina cargada mientras los demás esperan su candado. Eso tardó
 * hasta 60 s con carga 50-70 en las tandas de estres-verificar.sh; 180 s
 * es tres veces eso. Más arriba solo retrasa el rojo de un arranque
 * colgado de verdad. Un candado de un proceso muerto ya no hace esperar:
 * foto.mjs lo detecta por el pid.
 */
export const SETUP_TIMEOUT_MS = 180_000;
