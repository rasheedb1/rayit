/**
 * Simula que la máquina está MC_RELOJ_DIAS días en el futuro (CIM-12).
 *
 *   MC_RELOJ_DIAS=90 NODE_OPTIONS="--import $PWD/scripts/pruebas/maquina.mjs" pnpm verificar
 *
 * Lo carga estres-verificar.sh --dias en TODOS los procesos de la corrida
 * (pnpm, turbo, tsc, eslint, las pruebas). Es la pregunta «¿la puerta da
 * verde si la corro el 3 de enero?»: las suites que miran la demo llevan
 * su propio reloj anclado (reloj.mjs) y no lo notan; las que no (@mc/core,
 * @mc/connectors, la raíz) corren con la fecha movida. Con
 * MC_RELOJ_ANCLA=real tampoco se anclan las otras, y se ve lo que pasaría
 * sin el ancla.
 *
 * Mueve Date.now(), `new Date()` y `Date()` con un desfase fijo; el
 * tiempo sigue corriendo. performance no se toca (de ahí sale la hora de
 * verdad que usan reloj.mjs y db/lib/foto.mjs).
 */
const dias = Number(process.env.MC_RELOJ_DIAS ?? '0');
if (!Number.isInteger(dias)) {
  throw new Error(`MC_RELOJ_DIAS tiene que ser un número entero de días; vale «${process.env.MC_RELOJ_DIAS}».`);
}

if (dias !== 0) {
  const RealDate = Date;
  const ahora = () => Math.floor(performance.timeOrigin + performance.now() + dias * 86_400_000);
  // Una función y no una subclase, como en reloj.mjs: comparte el prototipo.
  function DateDeLaMaquina(...args) {
    if (!new.target) return new RealDate(ahora()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [ahora()] : args, new.target);
  }
  DateDeLaMaquina.prototype = RealDate.prototype;
  DateDeLaMaquina.parse = RealDate.parse;
  DateDeLaMaquina.UTC = RealDate.UTC;
  DateDeLaMaquina.now = ahora;
  globalThis.Date = DateDeLaMaquina;
  process.stderr.write(`reloj: la máquina a +${dias} días (pid ${process.pid})\n`);
}
