/**
 * El reemplazo de Date que comparten las dos simulaciones del reloj de
 * las pruebas (CIM-12): reloj.mjs (el ancla de las suites de la demo) y
 * maquina.mjs (la máquina N días adelante). Antes cada una llevaba su
 * copia; si se corregía un borde en una, la otra se quedaba atrás.
 *
 * Mueve Date.now(), `new Date()` sin argumentos y `Date()` sin `new`; el
 * resto de Date (con argumentos, parse, UTC, los métodos del prototipo)
 * es el de siempre. performance y los temporizadores no se tocan.
 */

/**
 * La hora real en ms, con el performance.now ORIGINAL guardado al cargar
 * este módulo: vi.useFakeTimers() de vitest también finge performance.now,
 * y leyéndolo en cada llamada un Date movido quedaba atado al reloj falso
 * (los afterEach con vi.useRealTimers() se colgaban). De aquí sale también
 * la hora de verdad que usa db/lib/foto.mjs para las edades de los candados.
 */
const origenPerf = performance.timeOrigin;
const ahoraPerf = performance.now.bind(performance);
export const horaReal = () => origenPerf + ahoraPerf();

/**
 * Quién dice su reloj, dentro de su propia línea: «reloj[@mc/db#test]».
 * Son el paquete y el script que pnpm pone en el entorno de cada proceso
 * de una tarea (sus hijos lo heredan: los procesos de vitest, los de
 * node --test). estres-verificar.sh cuenta las tareas que no lo dijeron
 * buscando esto, no el prefijo de turbo, que se mezcla cuando dos tareas
 * escriben a la vez (scripts/pruebas/estres-contar.sh).
 */
export function etiqueta(env = process.env) {
  return `reloj[${env.npm_package_name || '?'}#${env.npm_lifecycle_event || '?'}]`;
}

/**
 * Pone en globalThis.Date un Date cuyo «ahora» es `ahora()` (ms, puede
 * tener decimales: se trunca como Date.now). Devuelve el Date original.
 *
 * Una función y no una subclase: comparte el prototipo de Date, así que
 * `instanceof Date` sigue valiendo para las fechas que crea el propio
 * motor (structuredClone, los drivers), y `class X extends Date` sigue
 * creando instancias de X.
 */
export function instalarDate(ahora) {
  const RealDate = globalThis.Date;
  const ms = () => Math.floor(ahora());
  function DateMovido(...args) {
    // Llamada sin `new`, Date() devuelve la fecha de ahora como texto.
    if (!new.target) return new RealDate(ms()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [ms()] : args, new.target);
  }
  DateMovido.prototype = RealDate.prototype;
  DateMovido.parse = RealDate.parse;
  DateMovido.UTC = RealDate.UTC;
  DateMovido.now = ms;
  globalThis.Date = DateMovido;
  return RealDate;
}
