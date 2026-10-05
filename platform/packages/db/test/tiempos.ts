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
 * la máquina cargada mientras los demás esperan su candado. En las 28
 * corridas de estres-verificar.sh del 5-oct (carga hasta 77) lo más lento
 * fue la primera suite de @mc/db, que siembra la demo: 41 s. Construir la
 * foto en frío cuesta de 5 a 60 s según la carga; 180 s cubre las dos
 * cosas seguidas con margen. Más arriba solo retrasa el rojo de un
 * arranque colgado de verdad. Un candado de un proceso muerto ya no hace esperar:
 * foto.mjs lo detecta por el pid.
 */
export const SETUP_TIMEOUT_MS = 180_000;
