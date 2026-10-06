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
 * beforeAll/afterAll que abren o cierran la base embebida, y las pruebas
 * que consultan la demo varias veces: los mismos de @mc/db
 * (test/tiempos.ts), con su porqué y lo medido.
 */
export { PRUEBA_DB_TIMEOUT_MS, SETUP_TIMEOUT_MS } from "@mc/db/test/tiempos";

/** Una prueba cualquiera: el testTimeout de vitest.config.ts. */
export const PRUEBA_TIMEOUT_MS = 20_000;

/**
 * Una prueba de interfaz sin base que recorre un formulario entero con
 * varias transiciones (los dos formularios de aportes de CAM-4). Medido
 * (r4, 5-oct): la más lenta tarda menos de 2 s con la máquina tranquila;
 * el margen es para la máquina con dos verificar a la vez.
 */
export const PRUEBA_LENTA_MS = 30_000;

/**
 * findBy* y waitFor de testing-library (vitest.setup.ts). Por omisión es
 * 1 s; una acción mockeada más su transición de React pueden tardar más
 * con la máquina ocupada, sin que nada esté mal. Muy por debajo de
 * PRUEBA_TIMEOUT_MS: una espera que nunca se cumple sigue fallando.
 */
export const ESPERA_UI_MS = 5_000;

/**
 * Una espera de interfaz que encadena una acción mockeada, su transición
 * de React y un rerender (las confirmaciones de Ventas, el radar, los
 * aportes de campañas): los 5 s de ESPERA_UI_MS se agotaron alguna vez
 * con la máquina cargada sin que nada estuviera mal. La mitad de
 * PRUEBA_TIMEOUT_MS: una espera que nunca se cumple sigue fallando dentro
 * de su prueba, con el mensaje de testing-library y no con el del techo.
 */
export const ESPERA_UI_LARGA_MS = 10_000;
