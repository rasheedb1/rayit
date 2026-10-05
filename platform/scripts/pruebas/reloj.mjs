/**
 * El reloj de las pruebas (CIM-12): las suites que miran la demo corren
 * en un día fijo, no en el día en que alguien las corre.
 *
 * Lo cargan con `--import` los scripts `test` de @mc/db y @mc/worker
 * (package.json) y los procesos de vitest de @mc/web (vitest.config.ts,
 * execArgv). Nada fuera de las pruebas lo importa.
 *
 * Por qué: la demo del seed mezcla fechas relativas a hoy (la parrilla de
 * videos de 0002, las facturas abiertas de 0003) con hechos fijos (los
 * posts y las lecturas de las campañas, los gastos de septiembre), y
 * decenas de pruebas comparan contra esa demo. Con el reloj de la
 * máquina, la puerta se ponía roja sola: desde el 7-oct a las 06:00 UTC
 * (la lectura de 30 días del TikTok de Fresko), desde noviembre (la curva
 * de Café Alma deja de medirse) y desde diciembre (los gastos de
 * septiembre salen de la ventana de Finanzas; el año de la numeración).
 * Ninguno de esos rojos dice nada del código. Con el reloj anclado la
 * puerta da lo mismo el 7-oct que en enero.
 *
 * Qué mueve: Date.now(), `new Date()` sin argumentos y `Date()`. El
 * tiempo sigue corriendo desde el ancla (los plazos, los waitFor y los
 * temporizadores no cambian: performance y setTimeout no se tocan).
 * PGlite toma su reloj de Date.now() —el clock_gettime de Emscripten—,
 * así que now() y CURRENT_DATE de la base embebida se mueven igual. Un
 * Postgres real (TEST_DATABASE_URL) no: esas corridas no se anclan.
 *
 * Variables:
 *   MC_RELOJ_ANCLA       el instante en que «empieza» cada corrida. Por
 *                        omisión ANCLA_PRUEBAS. `real` lo apaga: las
 *                        pruebas ven el reloj de la máquina.
 *   MC_RELOJ_ANCLA_DIAS  N días después del ancla (negativo: antes). Para
 *                        ver que ninguna prueba depende de un día de la
 *                        semana concreto (estres-verificar.sh --ancla).
 *   MC_RELOJ_DIAS        simula que la MÁQUINA está N días en el futuro.
 *                        Con el ancla puesta no cambia nada, que es lo que
 *                        se quiere probar (estres-verificar.sh --dias);
 *                        con MC_RELOJ_ANCLA=real reproduce lo que pasaría
 *                        sin ella.
 *   MC_RELOJ_ORIGEN      la hora real (ms) a la que corresponde el ancla.
 *                        La fija el primer proceso que carga este módulo
 *                        (o vitest.config.ts) y la heredan sus hijos: así
 *                        todos los procesos de una corrida comparten el
 *                        mismo reloj y una foto sembrada por uno no tiene
 *                        filas «del futuro» para otro.
 *
 * Con TEST_DATABASE_URL (un Postgres real, el job «contra-postgres-real»
 * del CI) no se ancla salvo que MC_RELOJ_ANCLA lo pida: el reloj de ese
 * servidor no se puede mover, y un Date anclado contra un now() real
 * daría rojos que no existen.
 *
 * Si alguna de esas variables está puesta, cada proceso dice su reloj por
 * stderr («reloj: …»). No es adorno: turbo corre las tareas en modo
 * estricto y solo les pasa las variables que turbo.json declara; hasta el
 * 5-oct MC_RELOJ_DIAS no estaba declarada y las tandas «con el reloj
 * rotando» daban verde sin mover nada. estres-verificar.sh cuenta estas
 * líneas por tarea y da la corrida por roja si en alguna falta. Sin
 * variables (la puerta de todos los días) calla.
 */

/**
 * El día en que corren las pruebas: el 5-oct-2026, el día en que la
 * puerta se midió entera en verde (CIM-12), a las 15:00 UTC (las 10:00 en
 * Bogotá: el mismo día en UTC y en cualquier zona de UTC−12 a UTC+8).
 * Moverlo es una decisión, no un mantenimiento: las cifras de la demo que
 * clavan las pruebas son las de este día.
 */
export const ANCLA_PRUEBAS = '2026-10-05T15:00:00Z';

const DIA_MS = 86_400_000;

function entero(nombre) {
  const v = Number(process.env[nombre] ?? '0');
  if (!Number.isInteger(v)) throw new Error(`${nombre} tiene que ser un número entero de días; vale «${process.env[nombre]}».`);
  return v;
}

const diasMaquina = entero('MC_RELOJ_DIAS');
const diasAncla = entero('MC_RELOJ_ANCLA_DIAS');
const textoAncla = process.env.MC_RELOJ_ANCLA || (process.env.TEST_DATABASE_URL ? 'real' : ANCLA_PRUEBAS);
const anclado = textoAncla !== 'real';
const anclaMs = anclado ? Date.parse(textoAncla) : NaN;
if (anclado && Number.isNaN(anclaMs)) {
  throw new Error(`MC_RELOJ_ANCLA tiene que ser un instante ISO (2026-10-05T15:00:00Z) o «real»; vale «${textoAncla}».`);
}

/** La hora de verdad: performance no lo mueve nadie (ni este módulo ni vitest). */
const real = () => performance.timeOrigin + performance.now();

let ahora;
let aviso;
if (anclado) {
  if (!process.env.MC_RELOJ_ORIGEN) process.env.MC_RELOJ_ORIGEN = String(Math.round(real()));
  const origen = Number(process.env.MC_RELOJ_ORIGEN);
  const base = anclaMs + diasAncla * DIA_MS;
  ahora = () => base + (real() - origen);
  aviso = `reloj: anclado en ${new Date(base).toISOString()}${diasAncla ? ` (ancla ${diasAncla > 0 ? '+' : ''}${diasAncla} días)` : ''}${diasMaquina ? `; la máquina, a +${diasMaquina} días, no cuenta` : ''}`;
} else if (diasMaquina !== 0) {
  ahora = () => real() + diasMaquina * DIA_MS;
  aviso = `reloj: la máquina a +${diasMaquina} días, sin ancla`;
}

if (ahora) {
  const RealDate = Date;
  // Una función y no una subclase: comparte el prototipo de Date, así que
  // `instanceof Date` sigue valiendo para las fechas que crea el propio
  // motor (structuredClone, los drivers), y `class X extends Date` sigue
  // creando instancias de X.
  function DateDeLasPruebas(...args) {
    const ms = Math.floor(ahora());
    // Llamada sin `new`, Date() devuelve la fecha de ahora como texto.
    if (!new.target) return new RealDate(ms).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [ms] : args, new.target);
  }
  DateDeLasPruebas.prototype = RealDate.prototype;
  DateDeLasPruebas.parse = RealDate.parse;
  DateDeLasPruebas.UTC = RealDate.UTC;
  DateDeLasPruebas.now = () => Math.floor(ahora());
  globalThis.Date = DateDeLasPruebas;
  const pedido = ['MC_RELOJ_ANCLA', 'MC_RELOJ_ANCLA_DIAS', 'MC_RELOJ_DIAS'].some((v) => process.env[v]);
  if (pedido) process.stderr.write(`${aviso} (pid ${process.pid})\n`);
}
