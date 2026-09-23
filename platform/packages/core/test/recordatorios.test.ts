import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  definicionPaso,
  pasoRecordatorio,
  pasoVigente,
  pasosPendientes,
  pasoDeUrl,
  redactarRecordatorio,
  urlRecordatorio,
  PASOS_RECORDATORIO,
  type EntradaRecordatorio,
  type NumeroPaso,
  datosDePagoDe,
} from '../src/recordatorios.ts';
import { addDays, parseFinanceSettings } from '../src/facturacion.ts';

/** El vencimiento de FV-2026-007 si hoy fuera el 23 de septiembre de 2026. */
const VENCE = '2026-08-13';
const HOY = '2026-09-23';

/** daysBetween(HOY, VENCE) = −41. */
const base: EntradaRecordatorio = {
  paso: 3,
  numero: 'FV-2026-007',
  empresa: 'Hogar Lindo',
  campana: '3 historias · junio',
  total: '1100000.00',
  pendiente: '1100000.00',
  vencimiento: VENCE,
  hoy: HOY,
  moneda: 'COP',
  locale: 'es-CO',
  nombreCreador: 'Laura Gómez',
};

describe('en qué paso está una factura', () => {
  test('los cinco pasos caen en su día exacto', () => {
    for (const p of PASOS_RECORDATORIO) {
      const hoy = addDays(VENCE, p.offsetDias);
      assert.equal(pasoRecordatorio(VENCE, hoy), p.numero, `día ${p.offsetDias}`);
    }
  });

  test('ocho días antes todavía no toca', () => {
    assert.equal(pasoRecordatorio(VENCE, addDays(VENCE, -8)), 0);
  });

  test('el día del vencimiento es el paso 2, no el 1', () => {
    assert.equal(pasoRecordatorio(VENCE, VENCE), 2);
  });

  test('entre dos pasos manda el anterior', () => {
    assert.equal(pasoRecordatorio(VENCE, addDays(VENCE, 6)), 2);
    assert.equal(pasoRecordatorio(VENCE, addDays(VENCE, 20)), 3);
    assert.equal(pasoRecordatorio(VENCE, addDays(VENCE, 44)), 4);
  });

  test('el día 46 sigue siendo el paso 5: no hay un sexto', () => {
    assert.equal(pasoRecordatorio(VENCE, addDays(VENCE, 46)), 5);
    assert.equal(pasoRecordatorio(VENCE, addDays(VENCE, 400)), 5);
  });
});

describe('qué pasos quedan pendientes', () => {
  test('la factura vencida hace 41 días sin recordatorios previos tiene TRES: 2, 3 y 4', () => {
    const pendientes = pasosPendientes({ dueOn: VENCE, hoy: HOY, emitidos: [] });
    assert.deepEqual(pendientes.map((p) => p.numero), [2, 3, 4]);
  });

  test('el paso 1 caduca al vencer: no se emite tarde aunque su día ya pasara', () => {
    const pendientes = pasosPendientes({ dueOn: VENCE, hoy: addDays(VENCE, 1), emitidos: [] });
    assert.deepEqual(pendientes.map((p) => p.numero), [2]);
    assert.equal(pasoVigente(1, 0), false, 'el día del vencimiento ya no vence "en N días"');
    assert.equal(pasoVigente(1, 1), true);
    assert.equal(pasoVigente(4, -41), true, 'los pasos de mora no caducan');
  });

  test('lo ya emitido no se repite', () => {
    const pendientes = pasosPendientes({ dueOn: VENCE, hoy: HOY, emitidos: [2, 3] });
    assert.deepEqual(pendientes.map((p) => p.numero), [4]);
    assert.deepEqual(pasosPendientes({ dueOn: VENCE, hoy: HOY, emitidos: [2, 3, 4] }), []);
  });

  test('siete días antes del vencimiento sale el paso 1, y solo ese', () => {
    const pendientes = pasosPendientes({ dueOn: VENCE, hoy: addDays(VENCE, -7), emitidos: [] });
    assert.deepEqual(pendientes.map((p) => p.numero), [1]);
    assert.equal(pendientes[0]?.severity, 'info');
  });

  test('antes del paso 1 no hay nada que escribir', () => {
    assert.deepEqual(pasosPendientes({ dueOn: VENCE, hoy: addDays(VENCE, -8), emitidos: [] }), []);
  });

  test('la severidad sube: info, info, warning, warning, critical', () => {
    assert.deepEqual(
      PASOS_RECORDATORIO.map((p) => p.severity),
      ['info', 'info', 'warning', 'warning', 'critical'],
    );
  });

  test('definicionPaso rechaza un número que no es un paso', () => {
    assert.throws(() => definicionPaso(0), /paso de recordatorio 0/);
    assert.throws(() => definicionPaso(6), /paso de recordatorio 6/);
  });
});

describe('el texto de cada paso', () => {
  test('el paso 1 habla en futuro y con los días que faltan de verdad', () => {
    const r = redactarRecordatorio({ ...base, paso: 1, hoy: addDays(VENCE, -7) });
    assert.equal(r.asunto, 'Recordatorio: la factura FV-2026-007 vence el 13 de agosto de 2026');
    assert.match(r.cuerpo, /vence en 7 días/);
    assert.equal(r.severity, 'info');
    assert.equal(r.diasDeMora, 0);
  });

  test('el paso 2 el mismo día dice «vence hoy»', () => {
    const r = redactarRecordatorio({ ...base, paso: 2, hoy: VENCE });
    assert.equal(r.asunto, 'La factura FV-2026-007 vence hoy');
    assert.match(r.cuerpo, /vence hoy/);
    assert.match(r.cuerpo, /  Vence: 13 de agosto de 2026/);
  });

  test('el paso 2 emitido tarde no miente: dice que venció', () => {
    const r = redactarRecordatorio({ ...base, paso: 2, hoy: HOY });
    assert.equal(r.asunto, 'La factura FV-2026-007 venció el 13 de agosto de 2026');
    assert.doesNotMatch(r.cuerpo, /vence hoy/);
    assert.match(r.cuerpo, /  Venció: 13 de agosto de 2026/);
  });

  test('los tres tonos de mora suben, y cada uno dice los días reales', () => {
    const uno = redactarRecordatorio({ ...base, paso: 3 });
    const dos = redactarRecordatorio({ ...base, paso: 4 });
    const tres = redactarRecordatorio({ ...base, paso: 5 });
    assert.equal(uno.asunto, 'Factura FV-2026-007 pendiente · 41 días de mora');
    assert.equal(dos.asunto, 'Segundo aviso · factura FV-2026-007 con 41 días de mora');
    assert.equal(tres.asunto, 'Aviso formal de cobro · factura FV-2026-007');
    assert.equal(uno.severity, 'warning');
    assert.equal(dos.severity, 'warning');
    assert.equal(tres.severity, 'critical');
    assert.equal(uno.diasDeMora, 41);
    assert.match(uno.cuerpo, /Gracias por la gestión,/);
    assert.match(tres.cuerpo, /requiero formalmente/);
    assert.match(tres.cuerpo, /Atentamente,/);
  });

  test('«1 día» en singular', () => {
    const r = redactarRecordatorio({ ...base, paso: 3, hoy: addDays(VENCE, 1) });
    assert.match(r.cuerpo, /lleva 1 día de mora/);
    assert.doesNotMatch(r.cuerpo, /1 días/);
  });

  test('el dinero sale en la moneda y el locale del workspace, no en es-CO fijo', () => {
    const co = redactarRecordatorio(base);
    assert.match(co.cuerpo, /COP 1\.100\.000/);
    const mx = redactarRecordatorio({ ...base, moneda: 'MXN', locale: 'en-US', total: '25000.50', pendiente: '25000.50' });
    assert.match(mx.cuerpo, /MXN 25,000\.50/);
  });

  test('sin datos de pago dice dónde se configuran, no deja un hueco', () => {
    const r = redactarRecordatorio(base);
    assert.match(r.cuerpo, /Todavía no tienes datos de pago configurados/);
    assert.match(r.cuerpo, /Finanzas → Configuración/);
    assert.doesNotMatch(r.cuerpo, /A nombre de:/);
  });

  test('con datos de pago los escribe, y omite los que falten sin dejar rastro', () => {
    const r = redactarRecordatorio({ ...base, datosDePago: { titular: 'Laura Gómez', banco: 'Bancolombia', cuenta: 'Ahorros 123-456789-00' } });
    assert.match(r.cuerpo, /Datos para el pago:/);
    assert.match(r.cuerpo, /A nombre de: Laura Gómez/);
    assert.match(r.cuerpo, /Banco: Bancolombia/);
    assert.doesNotMatch(r.cuerpo, /NIT o cédula/, 'lo que no está no se nombra');
    assert.doesNotMatch(r.cuerpo, /Todavía no tienes datos de pago/);
  });

  test('costura FIN-8 → FIN-4: los datos de pago salen de settings.finanzas', () => {
    const conf = parseFinanceSettings({
      razon_social: 'Laura Gómez Estudio S.A.S.', identificacion: '901.234.567-8',
      banco: 'Bancolombia', cuenta: 'Ahorros 123-456789-00', enlace_pago: 'https://pagos.example/laura',
    });
    const r = redactarRecordatorio({ ...base, datosDePago: datosDePagoDe(conf) });
    assert.match(r.cuerpo, /A nombre de: Laura Gómez Estudio S\.A\.S\./);
    assert.match(r.cuerpo, /NIT o cédula: 901\.234\.567-8/);
    assert.match(r.cuerpo, /Banco: Bancolombia/);
    assert.match(r.cuerpo, /Cuenta: Ahorros 123-456789-00/);
    assert.match(r.cuerpo, /Enlace de pago: https:\/\/pagos\.example\/laura/);
    assert.doesNotMatch(r.cuerpo, /Todavía no tienes datos de pago/);
  });

  test('costura FIN-8 → FIN-4: sin banco, cuenta ni enlace, la frase que dice dónde configurarlos', () => {
    // Un workspace sin bloque (parseFinanceSettings tolera la ausencia) y
    // uno con solo la razón social: ninguno tiene cómo pagar.
    for (const bloque of [undefined, { razon_social: 'Laura Gómez' }]) {
      const datos = datosDePagoDe(parseFinanceSettings(bloque));
      assert.equal(datos, null);
      const r = redactarRecordatorio({ ...base, datosDePago: datos });
      assert.match(r.cuerpo, /configúralos una sola vez en Finanzas → Configuración → «Cómo te pagan»/);
      assert.doesNotMatch(r.cuerpo, /FIN-8/, 'el correo no habla en ids de historia');
    }
  });

  test('una factura parcial se cobra sobre el saldo, con las dos cifras', () => {
    const r = redactarRecordatorio({ ...base, paso: 3, pendiente: '400000.00' });
    assert.match(r.cuerpo, /Total de la factura: COP 1\.100\.000/);
    assert.match(r.cuerpo, /Pendiente por pagar: COP 400\.000/);
    assert.match(r.cuerpo, /saldo pendiente es de COP 400\.000/);
  });

  test('sin abonos no repite la misma cifra dos veces', () => {
    const r = redactarRecordatorio(base);
    assert.doesNotMatch(r.cuerpo, /Pendiente por pagar/);
  });

  test('sin campaña la línea no aparece: nunca un guion mudo', () => {
    const r = redactarRecordatorio({ ...base, campana: null });
    assert.doesNotMatch(r.cuerpo, /Campaña/);
    assert.doesNotMatch(r.cuerpo, /—/);
  });

  test('es texto plano copiable: sin HTML, sin espacios duros, y firmado', () => {
    for (const paso of [1, 2, 3, 4, 5] as NumeroPaso[]) {
      const r = redactarRecordatorio({ ...base, paso, hoy: paso === 1 ? addDays(VENCE, -7) : HOY });
      assert.doesNotMatch(r.cuerpo, /<[a-z/]/i, `paso ${paso}: sin HTML`);
      assert.doesNotMatch(r.cuerpo, /[  ]/, `paso ${paso}: sin espacios duros`);
      assert.ok(r.cuerpo.startsWith('Hola, equipo de Hogar Lindo:'), `paso ${paso}: saludo`);
      assert.ok(r.cuerpo.endsWith('Laura Gómez'), `paso ${paso}: firma`);
      assert.ok(r.asunto.length > 0 && !r.asunto.includes('\n'), `paso ${paso}: asunto de una línea`);
    }
  });

  test('los centavos no se pierden: el monto se formatea desde el texto', () => {
    const r = redactarRecordatorio({ ...base, moneda: 'USD', locale: 'en-US', total: '9007199254740.99', pendiente: '9007199254740.99' });
    assert.match(r.cuerpo, /USD 9,007,199,254,740\.99/);
  });
});

describe('el enlace y el paso que codifica', () => {
  test('el enlace lleva la factura y el paso', () => {
    assert.equal(urlRecordatorio('abc', 4), '/finanzas/facturas/abc?recordatorio=4');
  });

  test('pasoDeUrl solo acepta los cinco pasos', () => {
    assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=4'), 4);
    assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=1&otro=2'), 1);
    assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=0'), null);
    assert.equal(pasoDeUrl('/finanzas/facturas/x?recordatorio=6'), null);
    assert.equal(pasoDeUrl('/finanzas/facturas/x'), null);
    assert.equal(pasoDeUrl(null), null);
    assert.equal(pasoDeUrl(undefined), null);
  });

  test('ida y vuelta para los cinco pasos', () => {
    for (const p of PASOS_RECORDATORIO) {
      assert.equal(pasoDeUrl(urlRecordatorio('00000000-0000-4000-8000-000000000001', p.numero)), p.numero);
    }
  });
});

describe('el monto nunca sale en un error', () => {
  test('un monto que no es decimal lanza sin escribir la cifra', () => {
    const err = (() => {
      try {
        redactarRecordatorio({ ...base, total: '1100000,00' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'El monto del recordatorio no es un decimal.');
    assert.doesNotMatch(err.message, /1100000/, 'el log del job no lleva dinero');
  });
});
