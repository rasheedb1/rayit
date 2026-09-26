/**
 * VEN-12 · la especificación del detector de cifras, en una tabla.
 *
 * Cada fila es una frase y las cifras que el pre-vuelo tiene que ver en
 * ella (su texto tal cual, en orden). Una fila vacía dice que la frase no
 * lleva ninguna cifra de desempeño. Un caso nuevo es una fila nueva: el
 * detector vive en src/outreach/figures/ (contexto, múltiplos, puestos,
 * números en palabras, la búsqueda y la comparación con el claim).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFigures } from '../src/outreach/claims.ts';

const CASOS: ReadonlyArray<readonly [frase: string, cifras: readonly string[]]> = [
  // Dígitos, con su unidad.
  ['115.446 views de mediana', ['115.446']],
  ['el 37 % de mi audiencia', ['37 %']],
  ['6,7x mi mediana', ['6,7x']],
  ['400 mil seguidores', ['400 mil']],
  ['1,2 millones de reproducciones', ['1,2 millones']],
  // Números pequeños: solo con un sustantivo de desempeño detrás, y si no es lo que se ofrece.
  ['Trabajé con 11 marcas.', ['11']],
  ['Te mando 3 ideas de video.', []],
  ['Te propongo 3 videos y 2 historias.', []],
  ['mis 3 mejores videos', []],
  // Siempre cifras, por pequeñas que sean.
  ['Las ventas crecieron x3.', ['x3']],
  ['My sales grew 3-fold.', ['3-fold']],
  ['subió 5 pp', ['5 pp']],
  ['Soy la creadora #1 de recetas.', ['#1']],
  ['Estuve en el top 3.', ['top 3']],
  // Lo que no es una cifra de desempeño.
  ['Hablamos el 15 de octubre a las 10:30.', []],
  ['En 2026 lancé la serie.', []],
  ['Mis seguidores de 25 a 34 años.', []],
  ['Un reel de 30 segundos.', []],
  ['hace 2 años trabajé con ellos', []],
  ['el local de la calle 85', []],
  ['Cra. 7 # 71-21', []],
  // Pulido r1: una dirección con «la <número>» detrás de local, sede, tienda u oficina.
  ['Pasé por su local de la 85 y me encantó.', []],
  ['La sede de la 93 está llena.', []],
  ['Tengo 85 marcas aliadas.', ['85']],
  // Números en palabras.
  ['Ese video pasó las diez mil views.', ['diez mil']],
  ['Mis videos tienen el triple de views.', ['triple']],
  ['Trabajé con once marcas.', ['once']],
  ['Llegué a un millón de reproducciones.', ['un millón']],
  ['tres de cada cuatro seguidoras', ['tres de cada cuatro']],
  ['la mitad de mis seguidores', ['mitad']],
  // Pulido r1: la docena y la veintena son una cantidad.
  ['He trabajado con una docena de marcas.', ['una docena']],
  ['I have worked with a dozen brands.', ['dozen']],
  ['Hice media docena de campañas.', ['media docena']],
  ['Trabajé con una veintena de clientes.', ['una veintena']],
  ['I worked with a score of brands.', ['score']],
];

test('la tabla del detector de cifras: cada frase, las cifras que lleva', () => {
  for (const [frase, cifras] of CASOS) {
    assert.deepEqual(findFigures(frase).map((h) => h.raw), cifras, frase);
  }
});

test('una docena vale 12 y media docena 6; una veintena, 20', () => {
  const valor = (frase: string) => findFigures(frase)[0]?.values[0];
  assert.equal(valor('He trabajado con una docena de marcas.'), 12);
  assert.equal(valor('Hice media docena de campañas.'), 6);
  assert.equal(valor('Trabajé con dos docenas de marcas.'), 24);
  assert.equal(valor('Trabajé con una veintena de clientes.'), 20);
});
