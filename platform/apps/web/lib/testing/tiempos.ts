/**
 * Los techos de tiempo de las pruebas de la web, en un solo sitio (CIM-12).
 * Ningún archivo de pruebas lleva un número propio: o el de vitest.config.ts
 * (PRUEBA_TIMEOUT_MS), o una de estas constantes.
 *
 * Un techo no hace la prueba más lenta: solo decide cuándo una prueba
 * colgada se da por fallida. Los rojos por tiempo de verificar se
 * arreglaron quitando carga (vitest con pocos procesos, la demo sembrada
 * una vez por corrida, dos verificar a la vez como mucho), no subiendo
 * estos números.
 */

/**
 * beforeAll/afterAll que abren o cierran la base embebida. El mismo de
 * @mc/db (test/tiempos.ts), con su porqué.
 */
export { SETUP_TIMEOUT_MS } from "@mc/db/test/tiempos";

/** Una prueba cualquiera: el testTimeout de vitest.config.ts. */
export const PRUEBA_TIMEOUT_MS = 20_000;

/**
 * Una prueba que consulta la base embebida varias veces (una página
 * entera renderizada contra la demo, un ciclo de campaña). PGlite es WASM
 * en el hilo del proceso: con la máquina cargada, una consulta pesada
 * pasa del segundo. El más alto de los que había sueltos (300 s), para
 * no bajarle el techo a ninguna.
 */
export const PRUEBA_DB_TIMEOUT_MS = 300_000;

/** Una prueba de interfaz sin base que recorre un formulario entero con varias transiciones. */
export const PRUEBA_LENTA_MS = 30_000;

/**
 * findBy* y waitFor de testing-library (vitest.setup.ts). Por omisión es
 * 1 s; una acción mockeada más su transición de React pueden tardar más
 * con la máquina ocupada, sin que nada esté mal. Muy por debajo de
 * PRUEBA_TIMEOUT_MS: una espera que nunca se cumple sigue fallando.
 */
export const ESPERA_UI_MS = 5_000;
