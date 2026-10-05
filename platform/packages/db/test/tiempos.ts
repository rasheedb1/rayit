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

/**
 * Una prueba que consulta la base embebida varias veces (una página
 * entera renderizada contra la demo, un ciclo de campaña, un job del
 * worker que corre contra la foto, la importación de 2 385 posts de
 * RES-6). PGlite es WASM en el hilo del proceso: con la máquina cargada,
 * una consulta pesada pasa del segundo. Medido (r3, 5-oct): en 28
 * corridas de estres-verificar.sh, de a dos y con carga hasta 77, la más
 * lenta de la web (el CSV de casi 5 MB) no pasó de 6 s y la del worker,
 * de 11 s; 60 s es más de cinco veces eso.
 */
export const PRUEBA_DB_TIMEOUT_MS = 60_000;

/**
 * El --test-timeout de los scripts `test` de @mc/db y del worker
 * (package.json): el techo de cualquier prueba, describe o hook sin uno
 * propio. Lo más lento medido en las tandas del 5-oct fue una prueba de
 * @mc/db de 21 s (getSessionPermissions; con la máquina tranquila, 15 s).
 * node --test no lee constantes: el número va escrito en los package.json
 * y scripts/pruebas/verificar.test.mjs comprueba que dicen este.
 */
export const PRUEBA_SCRIPT_TIMEOUT_MS = 120_000;

/**
 * Un describe que abre su propia base en un `before` y agrupa decenas de
 * pruebas sobre ella (las de alcance de ACC-6, test/alcance.ts). node:test
 * aplica el techo al describe ENTERO, hook incluido: es el del arranque
 * (SETUP_TIMEOUT_MS, el peor caso de abrir la base) más el de las
 * pruebas. Medido (r4, 5-oct): el describe de alcance más largo tarda
 * 1,4 s con la máquina tranquila (lo de las tandas de estrés, en
 * docs/propuestas/CIM-12.md §Resultado). Antes eran 900 s, que no salían
 * de ninguna medida.
 */
export const DESCRIBE_DB_TIMEOUT_MS = SETUP_TIMEOUT_MS + PRUEBA_DB_TIMEOUT_MS;
