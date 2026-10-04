/**
 * Corre las pruebas «como si fuera dentro de N días» (CIM-12).
 *
 *   MC_RELOJ_DIAS=3 NODE_OPTIONS="--import $PWD/scripts/pruebas/reloj.mjs" pnpm verificar
 *
 * scripts/estres-verificar.sh lo hace solo con --dias-rotando: cada
 * ronda con el reloj un día más adelante, así que siete rondas pasan por
 * los siete días de la semana.
 *
 * Por qué hace falta: varias pruebas daban rojo según el día en que se
 * corrían (un sábado, un mes después de escribirlas) y no según el
 * código. La demo del seed se siembra relativa a hoy, así que una cifra
 * clavada en una prueba puede ser cierta solo el día que se escribió.
 * Con este módulo esa clase de fallo se reproduce cuando uno quiere, en
 * vez de aparecer sola un domingo en la puerta de calidad de otro.
 *
 * Qué mueve: Date.now() y `new Date()` sin argumentos, con un desfase
 * fijo, así que el tiempo sigue corriendo (los plazos, los waitFor y los
 * temporizadores no cambian). PGlite toma su reloj de Date.now() —su
 * clock_gettime de Emscripten—, así que now() y CURRENT_DATE de la base
 * embebida se mueven igual. Un Postgres real (TEST_DATABASE_URL) no.
 *
 * Sin MC_RELOJ_DIAS (o con 0) no toca nada. Nunca se carga fuera de las
 * pruebas: no lo importa ningún paquete.
 */
const dias = Number(process.env.MC_RELOJ_DIAS ?? '0');
if (!Number.isFinite(dias) || !Number.isInteger(dias)) {
  throw new Error(`MC_RELOJ_DIAS tiene que ser un número entero de días; vale «${process.env.MC_RELOJ_DIAS}».`);
}

if (dias !== 0) {
  const desfase = dias * 86_400_000;
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);

  // Una función y no una subclase: comparte el prototipo de Date, así que
  // `instanceof Date` sigue valiendo para las fechas que crea el propio
  // motor (structuredClone, los drivers), y `class X extends Date` sigue
  // creando instancias de X.
  function DateDesplazada(...args) {
    // Llamada sin `new`, Date() devuelve la fecha de ahora como texto.
    if (!new.target) return new RealDate(realNow() + desfase).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [realNow() + desfase] : args, new.target);
  }
  DateDesplazada.prototype = RealDate.prototype;
  DateDesplazada.parse = RealDate.parse;
  DateDesplazada.UTC = RealDate.UTC;
  DateDesplazada.now = () => realNow() + desfase;
  globalThis.Date = DateDesplazada;
}
