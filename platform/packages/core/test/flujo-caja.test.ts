import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mesDe,
  mesDesplazado,
  promedioMensual,
  proyeccionDePlataformas,
  ultimoMesCerrado,
  ventanaDeMeses,
  VENTANA_PROMEDIO_MESES,
} from '../src/flujo-caja.ts';

describe('meses como strings', () => {
  test("mesDe recorta 'YYYY-MM-DD' y rechaza lo que no es una fecha", () => {
    assert.equal(mesDe('2026-09-30'), '2026-09');
    assert.throws(() => mesDe('2026-09'), /Fecha inválida/);
    assert.throws(() => mesDe('2026-13-01'), /Fecha inválida/);
    assert.throws(() => mesDe('30/09/2026'), /Fecha inválida/);
  });

  test('mesDesplazado cruza el año en los dos sentidos', () => {
    assert.equal(mesDesplazado('2026-01', -1), '2025-12');
    assert.equal(mesDesplazado('2026-12', 1), '2027-01');
    assert.equal(mesDesplazado('2026-09', -12), '2025-09');
    assert.equal(mesDesplazado('2026-09', 0), '2026-09');
    assert.throws(() => mesDesplazado('2026-9', -1), /Mes inválido/);
  });

  test('el mes en curso no cuenta: el último cerrado es el anterior', () => {
    assert.equal(ultimoMesCerrado('2026-09-23'), '2026-08');
    assert.equal(ultimoMesCerrado('2026-01-01'), '2025-12');
  });

  test('ventanaDeMeses va del más viejo al más nuevo', () => {
    assert.deepEqual(ventanaDeMeses('2026-08', 3), ['2026-06', '2026-07', '2026-08']);
    assert.deepEqual(ventanaDeMeses('2026-01', 3), ['2025-11', '2025-12', '2026-01']);
    assert.throws(() => ventanaDeMeses('2026-08', 0), /Ventana inválida/);
  });
});

describe('promedio de los últimos tres meses', () => {
  const hoy = '2026-09-23'; // último mes cerrado: 2026-08; ventana: jun, jul, ago

  test('tres meses con datos: la media de los tres', () => {
    const r = promedioMensual(
      [
        { mes: '2026-06', monto: '1000000.00' },
        { mes: '2026-07', monto: '2000000.00' },
        { mes: '2026-08', monto: '3000000.00' },
      ],
      { hoy },
    );
    assert.equal(r.estimado, '2000000.00');
    assert.equal(r.total, '6000000.00');
    assert.equal(r.mesesConDatos, 3);
    assert.equal(r.mesesPromediados, 3);
    assert.equal(r.desde, '2026-06');
    assert.equal(r.hasta, '2026-08');
  });

  test('sin ningún mes con datos el estimado es null, NO cero', () => {
    const r = promedioMensual([], { hoy });
    assert.equal(r.estimado, null);
    assert.equal(r.total, null);
    assert.equal(r.mesesConDatos, 0);
    assert.equal(r.mesesPromediados, 0);
    assert.equal(r.desde, null);
  });

  test('un mes fuera de la ventana no cuenta, y tampoco convierte la serie en vacía', () => {
    const r = promedioMensual([{ mes: '2026-02', monto: '9000000.00' }], { hoy });
    assert.equal(r.estimado, null, 'febrero está fuera de junio–agosto');
  });

  test('un mes SIN pago dentro del tramo medido cuenta como cero', () => {
    // Junio 900 000, julio nada, agosto 300 000 → (900 000 + 300 000) / 3.
    const r = promedioMensual(
      [
        { mes: '2026-06', monto: '900000.00' },
        { mes: '2026-08', monto: '300000.00' },
      ],
      { hoy },
    );
    assert.equal(r.mesesConDatos, 2);
    assert.equal(r.mesesPromediados, 3, 'julio fue un cero de verdad: la plataforma no pagó');
    assert.equal(r.estimado, '400000.00');
  });

  test('los meses ANTERIORES al primer dato no se dividen: el creador acababa de empezar', () => {
    // Solo agosto tiene dato: se divide entre 1, no entre 3.
    const r = promedioMensual([{ mes: '2026-08', monto: '300000.00' }], { hoy });
    assert.equal(r.mesesPromediados, 1);
    assert.equal(r.desde, '2026-08');
    assert.equal(r.estimado, '300000.00');
  });

  test('varias filas del mismo mes se suman antes de promediar', () => {
    const r = promedioMensual(
      [
        { mes: '2026-08', monto: '100000.00' },
        { mes: '2026-08', monto: '50000.50' },
      ],
      { hoy },
    );
    assert.equal(r.total, '150000.50');
    assert.equal(r.mesesConDatos, 1);
    assert.equal(r.estimado, '150000.50');
  });

  test('el redondeo es al centavo, mitad hacia arriba, y no pasa por number', () => {
    // 1.00 entre 3 meses = 0,3333… → 0,33. Y 0.01 entre 2 = 0,005 → 0,01.
    const tres = promedioMensual(
      [
        { mes: '2026-06', monto: '1.00' },
        { mes: '2026-07', monto: '0' },
        { mes: '2026-08', monto: '0' },
      ],
      { hoy },
    );
    assert.equal(tres.estimado, '0.33');

    const dos = promedioMensual(
      [
        { mes: '2026-07', monto: '0.01' },
        { mes: '2026-08', monto: '0' },
      ],
      { hoy },
    );
    assert.equal(dos.estimado, '0.01');
  });

  test('una cifra que no cabe en un double sigue exacta', () => {
    const r = promedioMensual(
      [
        { mes: '2026-06', monto: '90071992547409.91' },
        { mes: '2026-07', monto: '90071992547409.91' },
        { mes: '2026-08', monto: '90071992547409.91' },
      ],
      { hoy },
    );
    assert.equal(r.total, '270215977642229.73');
    assert.equal(r.estimado, '90071992547409.91');
  });

  test('la ventana se puede pedir de otro tamaño', () => {
    const r = promedioMensual(
      [
        { mes: '2026-03', monto: '600000.00' },
        { mes: '2026-08', monto: '600000.00' },
      ],
      { hoy, ventana: 6 },
    );
    assert.equal(r.desde, '2026-03', 'marzo entra en una ventana de seis');
    assert.equal(r.mesesPromediados, 6);
    assert.equal(r.estimado, '200000.00');
  });
});

describe('la fila que consumirá FIN-6', () => {
  test('lleva la moneda, la base y la ventana, y no escribe ni una frase', () => {
    const p = proyeccionDePlataformas([{ mes: '2026-08', monto: '480000.00' }], {
      hoy: '2026-09-23',
      currency: 'COP',
    });
    assert.equal(p.estimado, '480000.00');
    assert.equal(p.currency, 'COP');
    assert.equal(p.base, 'promedio_meses');
    assert.equal(p.ventana, VENTANA_PROMEDIO_MESES);
    assert.equal(p.hasta, '2026-08');
    // Ni un texto de interfaz en la salida: los textos viven en el
    // messages.ts del módulo, no en @mc/core.
    assert.doesNotMatch(JSON.stringify(p), /estimado por|promedio de los|Ingresos/);
  });

  test('sin datos, la fila existe y su cifra es null', () => {
    const p = proyeccionDePlataformas([], { hoy: '2026-09-23', currency: 'MXN' });
    assert.equal(p.estimado, null);
    assert.equal(p.currency, 'MXN');
  });
});
