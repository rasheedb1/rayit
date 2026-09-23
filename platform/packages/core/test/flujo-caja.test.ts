import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lunesDeLaSemana,
  projectCashflow,
  semanalDeMensual,
  SEMANAS_POR_DEFECTO,
  type CashflowInput,
  type FacturaPorCobrar,
  type GastoRecurrente,
  type NegocioGanado,
} from '../src/flujo-caja.ts';

// Un miércoles: 2026-09-23. Su lunes es el 21.
const HOY = '2026-09-23';
const LUNES = '2026-09-21';

function factura(over: Partial<FacturaPorCobrar> = {}): FacturaPorCobrar {
  return {
    id: 'f1', number: 'FV-2026-010', companyName: 'Café Alma', currency: 'COP',
    outstanding: '3100000.00', dueOn: '2026-09-30', ...over,
  };
}

function negocio(over: Partial<NegocioGanado> = {}): NegocioGanado {
  return {
    id: 'd1', name: 'Serie de 3 videos', companyName: 'Fresko Market', currency: 'COP',
    amount: '6000000.00', expectedCloseDate: '2026-09-25', hasInvoice: false, ...over,
  };
}

function gasto(over: Partial<GastoRecurrente> = {}): GastoRecurrente {
  return { id: 'g1', label: 'Edición de video', currency: 'COP', amount: '1800000.00', incurredOn: '2026-09-01', ...over };
}

function entrada(over: Partial<CashflowInput> = {}): CashflowInput {
  return {
    today: HOY, currency: 'COP', reservaRate: '0.11', plazoDias: 30,
    facturas: [], negocios: [], gastos: [], ...over,
  };
}

describe('calendario', () => {
  test('la semana empieza el lunes, y el lunes es su propio lunes', () => {
    assert.equal(lunesDeLaSemana('2026-09-23'), '2026-09-21', 'miércoles');
    assert.equal(lunesDeLaSemana('2026-09-21'), '2026-09-21', 'lunes');
    assert.equal(lunesDeLaSemana('2026-09-27'), '2026-09-21', 'domingo');
    assert.equal(lunesDeLaSemana('2026-09-28'), '2026-09-28', 'el lunes siguiente');
  });

  test('cruza el fin de mes y el fin de año sin inventar días', () => {
    assert.equal(lunesDeLaSemana('2026-01-01'), '2025-12-29');
    assert.equal(lunesDeLaSemana('2026-03-01'), '2026-02-23');
  });

  test('una fecha que no es YYYY-MM-DD se rechaza', () => {
    assert.throws(() => lunesDeLaSemana('23/09/2026'), /YYYY-MM-DD/);
  });

  test('el mensual se reparte por semana: × 12 / 52, mitad hacia arriba', () => {
    assert.equal(semanalDeMensual('3700000.00'), '853846.15');
    assert.equal(semanalDeMensual('0.00'), '0.00');
    // 100,00 × 12 / 52 = 23,0769… → 23,08
    assert.equal(semanalDeMensual('100.00'), '23.08');
  });
});

describe('una semana con cobro, gasto e impuesto (el «terminado cuando»)', () => {
  const r = projectCashflow(entrada({
    facturas: [factura({ dueOn: '2026-09-25', outstanding: '3100000.00' })],
    gastos: [gasto({ amount: '3700000.00' })],
  }));

  test('la primera semana empieza el lunes y termina el domingo', () => {
    assert.equal(r.semanas[0]?.inicio, LUNES);
    assert.equal(r.semanas[0]?.fin, '2026-09-27');
  });

  test('cobros, gastos, impuestos, neto y acumulado cuadran, y todo es string', () => {
    const s = r.semanas[0]!;
    assert.equal(s.cobros, '3100000.00');
    assert.equal(s.gastos, '853846.15');
    assert.equal(s.impuestos, '341000.00', '11 % de 3 100 000');
    assert.equal(s.neto, '1905153.85', '3 100 000 − 853 846,15 − 341 000');
    assert.equal(s.acumulado, '1905153.85', 'la primera semana: acumulado = neto');
  });

  test('el detalle dice de qué factura salió el cobro', () => {
    assert.deepEqual(r.semanas[0]?.detalle, [{
      kind: 'factura', id: 'f1', label: 'FV-2026-010', companyName: 'Café Alma',
      amount: '3100000.00', esperadoEl: '2026-09-25',
    }]);
  });

  test('una semana sin cobros no aparta impuestos, pero sí carga su gasto', () => {
    const s = r.semanas[1]!;
    assert.equal(s.cobros, '0.00');
    assert.equal(s.impuestos, '0.00');
    assert.equal(s.neto, '-853846.15');
    assert.equal(s.acumulado, '1051307.70');
  });

  test('ninguna cifra es number', () => {
    for (const s of r.semanas) {
      for (const v of [s.cobros, s.gastos, s.impuestos, s.neto, s.acumulado]) {
        assert.equal(typeof v, 'string');
        assert.match(v, /^-?\d+\.\d{2}$/);
      }
      for (const d of s.detalle) assert.equal(typeof d.amount, 'string');
    }
    assert.equal(typeof r.proyectado, 'string');
    assert.equal(typeof r.gastoMensual, 'string');
    assert.equal(typeof r.gastoSemanal, 'string');
    assert.equal(typeof r.excluidos.vencidas.amount, 'string');
  });
});

describe('ocho semanas exactas', () => {
  test('son ocho, consecutivas, sin hueco ni solape', () => {
    const r = projectCashflow(entrada());
    assert.equal(r.semanas.length, SEMANAS_POR_DEFECTO);
    assert.equal(r.semanas.length, 8);
    assert.equal(r.semanas[0]?.inicio, LUNES);
    assert.equal(r.semanas[7]?.inicio, '2026-11-09');
    assert.equal(r.semanas[7]?.fin, '2026-11-15');
    for (let i = 1; i < r.semanas.length; i++) {
      const anterior = r.semanas[i - 1]!;
      const actual = r.semanas[i]!;
      assert.equal(new Date(actual.inicio).getTime() - new Date(anterior.inicio).getTime(), 7 * 86_400_000);
      assert.ok(anterior.fin < actual.inicio);
    }
  });

  test('el acumulado es la suma corrida de los netos, y `proyectado` es el último', () => {
    const r = projectCashflow(entrada({ gastos: [gasto({ amount: '3700000.00' })] }));
    let suma = 0;
    for (const s of r.semanas) {
      suma += Number(s.neto);
      assert.equal(Number(s.acumulado).toFixed(2), suma.toFixed(2));
    }
    assert.equal(r.proyectado, r.semanas[7]?.acumulado);
    assert.equal(r.proyectado, '-6830769.20', '8 × −853 846,15');
  });

  test('un cobro más allá de la octava semana queda fuera de la ventana, no en la última', () => {
    const r = projectCashflow(entrada({ facturas: [factura({ dueOn: '2026-11-16', outstanding: '900000.00' })] }));
    assert.equal(r.semanas[7]?.cobros, '0.00');
    assert.deepEqual(r.excluidos.fueraDeVentana, { count: 1, amount: '900000.00' });
  });

  test('se pueden pedir otras ocho: el número de semanas es parámetro, no constante', () => {
    assert.equal(projectCashflow(entrada({ semanas: 4 })).semanas.length, 4);
    assert.throws(() => projectCashflow(entrada({ semanas: 0 })), /entre 1 y 52/);
    assert.throws(() => projectCashflow(entrada({ semanas: 8.5 })), /entre 1 y 52/);
  });
});

describe('una factura vencida', () => {
  const r = projectCashflow(entrada({
    facturas: [
      factura({ id: 'v', number: 'FV-2026-007', dueOn: '2026-08-13', outstanding: '1100000.00' }),
      factura({ dueOn: '2026-09-30', outstanding: '3100000.00' }),
    ],
  }));

  test('no entra en ninguna semana: la proyección es un piso', () => {
    const total = r.semanas.reduce((acc, s) => acc + Number(s.cobros), 0);
    assert.equal(total, 3100000);
    for (const s of r.semanas) {
      assert.ok(!s.detalle.some((d) => d.id === 'v'), `la vencida no está en la semana del ${s.inicio}`);
    }
  });

  test('pero se cuenta y se suma, para que la pantalla la explique', () => {
    assert.deepEqual(r.excluidos.vencidas, { count: 1, amount: '1100000.00' });
  });

  test('una que vence HOY sí entra: vencida es due_on < hoy', () => {
    const hoyMismo = projectCashflow(entrada({ facturas: [factura({ dueOn: HOY, outstanding: '500000.00' })] }));
    assert.equal(hoyMismo.excluidos.vencidas.count, 0);
    assert.equal(hoyMismo.semanas[0]?.cobros, '500000.00');
  });
});

describe('negocios ganados', () => {
  test('uno sin factura se cobra a expected_close_date + plazo del workspace', () => {
    const r = projectCashflow(entrada({ negocios: [negocio({ expectedCloseDate: '2026-09-25', amount: '6000000.00' })] }));
    // 25-sep + 30 días = 25-oct (domingo) → semana del 19 de octubre, la quinta.
    assert.equal(r.semanas[4]?.cobros, '6000000.00');
    assert.equal(r.semanas[4]?.detalle[0]?.esperadoEl, '2026-10-25');
    assert.equal(r.semanas[4]?.detalle[0]?.kind, 'negocio');
  });

  test('uno que YA tiene factura no suma: contarlo sería contar dos veces', () => {
    const r = projectCashflow(entrada({
      facturas: [factura({ outstanding: '3100000.00', dueOn: '2026-09-30' })],
      negocios: [negocio({ hasInvoice: true, amount: '3100000.00' })],
    }));
    const total = r.semanas.reduce((acc, s) => acc + Number(s.cobros), 0);
    assert.equal(total, 3100000, 'solo la factura');
    assert.deepEqual(r.excluidos.yaFacturados, { count: 1, amount: '3100000.00' });
  });

  test('uno sin fecha de cierre queda fuera y se cuenta: «N negocios por X»', () => {
    const r = projectCashflow(entrada({
      negocios: [negocio({ expectedCloseDate: null, amount: '9000000.00' }), negocio({ id: 'd2', expectedCloseDate: null, amount: '2000000.00' })],
    }));
    assert.deepEqual(r.excluidos.sinFecha, { count: 2, amount: '11000000.00' });
    for (const s of r.semanas) assert.equal(s.cobros, '0.00');
  });

  test('uno ganado sin monto tampoco se proyecta', () => {
    const r = projectCashflow(entrada({ negocios: [negocio({ amount: null })] }));
    assert.equal(r.excluidos.sinFecha.count, 1);
    assert.equal(r.excluidos.sinFecha.amount, '0.00', 'no hay monto que sumar');
  });
});

describe('moneda distinta a la del workspace', () => {
  test('factura, negocio y gasto en otra moneda quedan fuera, con aviso', () => {
    const r = projectCashflow(entrada({
      facturas: [factura({ currency: 'USD', outstanding: '2000.00', dueOn: '2026-09-30' })],
      negocios: [negocio({ currency: 'MXN', amount: '50000.00' })],
      gastos: [gasto({ currency: 'USD', amount: '90.00' }), gasto({ id: 'g2', amount: '3700000.00' })],
    }));
    for (const s of r.semanas) assert.equal(s.cobros, '0.00');
    assert.equal(r.excluidos.otraMoneda.count, 3);
    assert.deepEqual(r.excluidos.otraMoneda.monedas, ['MXN', 'USD']);
    assert.equal(r.gastoMensual, '3700000.00', 'el gasto en USD no se suma al mensual');
  });

  test('la moneda se compara sin distinguir mayúsculas', () => {
    const r = projectCashflow(entrada({ facturas: [factura({ currency: 'cop', dueOn: '2026-09-30' })] }));
    assert.equal(r.excluidos.otraMoneda.count, 0);
    assert.equal(r.semanas[1]?.cobros, '3100000.00');
  });
});

describe('gastos recurrentes', () => {
  test('solo cuenta el mes más reciente: la misma suscripción está una vez por mes', () => {
    const meses = ['2026-07-01', '2026-08-01', '2026-09-01'];
    const gastos = meses.flatMap((d, i) => [
      gasto({ id: `e${i}a`, amount: '1800000.00', incurredOn: d }),
      gasto({ id: `e${i}b`, amount: '1900000.00', incurredOn: d }),
    ]);
    const r = projectCashflow(entrada({ gastos }));
    assert.equal(r.gastoMensual, '3700000.00', 'septiembre, no los tres meses');
    assert.equal(r.gastoSemanal, '853846.15');
    for (const s of r.semanas) assert.equal(s.gastos, '853846.15');
  });

  test('sin gastos recurrentes, el gasto semanal es cero y no aparece un guion mudo', () => {
    const r = projectCashflow(entrada({ facturas: [factura()] }));
    assert.equal(r.gastoMensual, '0.00');
    assert.equal(r.gastoSemanal, '0.00');
  });
});

describe('vacío y semana más ajustada', () => {
  test('sin cobros ni gastos, `vacio` y ninguna semana ajustada', () => {
    const r = projectCashflow(entrada());
    assert.equal(r.vacio, true);
    assert.equal(r.semanaMasAjustada, null);
    assert.equal(r.proyectado, '0.00');
  });

  test('con solo una factura vencida sigue vacío: no hay nada que proyectar', () => {
    const r = projectCashflow(entrada({ facturas: [factura({ dueOn: '2026-08-13' })] }));
    assert.equal(r.vacio, true);
    assert.equal(r.excluidos.vencidas.count, 1);
  });

  test('la semana más ajustada es el fondo de caja: el acumulado más bajo', () => {
    const r = projectCashflow(entrada({
      facturas: [factura({ dueOn: '2026-10-12', outstanding: '9000000.00' })],
      gastos: [gasto({ amount: '3700000.00' })],
    }));
    // El acumulado baja tres semanas y sube en la del 12 de octubre.
    assert.equal(r.semanaMasAjustada?.inicio, '2026-10-05');
    assert.equal(r.semanaMasAjustada?.acumulado, '-2561538.45');
  });

  test('con todo positivo, la más ajustada es la primera; con empate, también', () => {
    const r = projectCashflow(entrada({ facturas: [factura({ dueOn: '2026-09-25', outstanding: '9000000.00' })] }));
    assert.equal(r.semanaMasAjustada?.inicio, LUNES);
  });
});

describe('entradas inválidas', () => {
  test('un `today` que no es fecha se rechaza antes de calcular nada', () => {
    assert.throws(() => projectCashflow(entrada({ today: 'hoy' })), /YYYY-MM-DD/);
  });

  test('un `dueOn` que no es fecha se rechaza', () => {
    assert.throws(() => projectCashflow(entrada({ facturas: [factura({ dueOn: '30/09/2026' })] })), /YYYY-MM-DD/);
  });
});
