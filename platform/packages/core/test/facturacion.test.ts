import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents, fromCents, normalizeDecimal, mulRateHalfUp, addDecimal, subDecimal, compareDecimal,
  pctToRate, rateToPct, computeInvoiceTotals, subtotalFromTotal,
  transitionInvoice, InvalidTransition, canTransition, INVOICE_TRANSITIONS, INVOICE_STATUSES,
  deriveStatus, agingBucket, daysBetween, addDays,
  nextInvoiceNumber, parseInvoiceNumber,
  applyPayment, taxReserveFor, reserveRateFrom, reservePeriod,
  MONTO_MAXIMO, PAYABLE_STATUSES, PAYMENT_METHODS, PAYMENT_METHOD_LABEL_ES, isPaymentMethod,
  InvoiceError, InvoiceNotPayable, PaymentAmountInvalid, PaymentExceedsOutstanding,
  AmountOutOfRange, PaymentDateInFuture, InvoicePaymentConflict, TaxReserveRateInvalid,
} from '../src/facturacion.ts';
import { hoyEnZona } from '../src/zonas.ts';

// ---------------------------------------------------------------- decimales

test('los decimales viajan como string y se operan en centavos', () => {
  assert.equal(toCents('5200000.00'), 520000000n);
  assert.equal(toCents('5200000'), 520000000n);
  assert.equal(toCents('0.5'), 50n);
  assert.equal(toCents('-12.34'), -1234n);
  assert.equal(fromCents(520000000n), '5200000.00');
  assert.equal(fromCents(-5n), '-0.05');
  assert.equal(normalizeDecimal('7'), '7.00');
  assert.throws(() => toCents('5.200.000'), /Monto inválido/);
  assert.throws(() => toCents('abc'), /Monto inválido/);
  assert.throws(() => toCents(''), /Monto inválido/);
});

test('más de dos decimales se redondean al centavo, mitad hacia arriba', () => {
  assert.equal(normalizeDecimal('1.005'), '1.01');
  assert.equal(normalizeDecimal('1.004'), '1.00');
  assert.equal(normalizeDecimal('2.675'), '2.68'); // el caso clásico que float rompe
});

test('multiplicar por una tasa redondea half-up al centavo', () => {
  assert.equal(mulRateHalfUp('2605042.02', '0.19'), '494957.98');
  assert.equal(mulRateHalfUp('100.00', '0.19'), '19.00');
  assert.equal(mulRateHalfUp('0.10', '0.05'), '0.01'); // 0.005 → sube
  assert.equal(mulRateHalfUp('0.10', '0.04'), '0.00'); // 0.004 → baja
  assert.equal(mulRateHalfUp('1000.00', '0.1100'), '110.00');
  assert.throws(() => mulRateHalfUp('1.00', '-0.1'), /Tasa inválida/);
  assert.throws(() => mulRateHalfUp('1.00', '0.1234567'), /demasiados decimales/);
});

test('sumas, restas y comparación', () => {
  assert.equal(addDecimal('5200000.00', '3100000.00'), '8300000.00');
  assert.equal(subDecimal('3100000.00', '286554.62'), '2813445.38');
  assert.equal(compareDecimal('1.00', '1.000'), 0);
  assert.equal(compareDecimal('0.99', '1.00'), -1);
  assert.equal(compareDecimal('1.01', '1.00'), 1);
});

test('porcentajes del formulario a tasas y de vuelta', () => {
  assert.equal(pctToRate('19'), '0.19');
  assert.equal(pctToRate('11'), '0.11');
  assert.equal(pctToRate('0'), '0');
  assert.equal(pctToRate('19,5'), '0.195');
  assert.equal(pctToRate('100'), '1');
  assert.equal(pctToRate('2.5'), '0.025');
  assert.equal(rateToPct('0.19'), '19');
  assert.equal(rateToPct('0.1100'), '11');
  assert.equal(rateToPct('0.195'), '19,5');
  assert.equal(rateToPct('0'), '0');
  assert.throws(() => pctToRate('-5'), /Porcentaje inválido/);
});

// ---------------------------------------------------------------- totales

test('los totales por defecto: IVA 19 %, retención 11 %, total = subtotal + IVA', () => {
  const t = computeInvoiceTotals({ subtotal: '2605042.02' });
  assert.deepEqual(t, {
    subtotal: '2605042.02',
    tax: '494957.98',
    withholding: '286554.62',
    total: '3100000.00',
    net: '2813445.38',
  });
});

test('las tasas son editables y el subtotal se normaliza', () => {
  const t = computeInvoiceTotals({ subtotal: '1000000', taxRate: '0', withholdingRate: '0.025' });
  assert.equal(t.tax, '0.00');
  assert.equal(t.withholding, '25000.00');
  assert.equal(t.total, '1000000.00');
  assert.equal(t.net, '975000.00');
  assert.throws(() => computeInvoiceTotals({ subtotal: '-1' }), /negativo/);
});

test('el subtotal que produce un total con IVA incluido', () => {
  // Los montos del seed 0003: exactos.
  for (const [total, subtotal] of [
    ['3100000.00', '2605042.02'],
    ['5200000.00', '4369747.90'],
    ['1100000.00', '924369.75'],
    ['4700000.00', '3949579.83'],
  ] as const) {
    const s = subtotalFromTotal(total);
    assert.equal(s, subtotal);
    assert.equal(computeInvoiceTotals({ subtotal: s }).total, total);
  }
  // 4 500 000 no admite descomposición exacta: devuelve el mejor por debajo.
  const s = subtotalFromTotal('4500000.00');
  assert.equal(computeInvoiceTotals({ subtotal: s }).total, '4499999.99');
  assert.equal(subtotalFromTotal('119.00', '0.19'), '100.00');
});

// ---------------------------------------------------------------- transiciones

test('las transiciones válidas son exactamente las del prompt', () => {
  assert.deepEqual(INVOICE_TRANSITIONS, {
    draft: ['sent', 'void'],
    sent: ['partial', 'paid', 'overdue', 'void'],
    partial: ['paid', 'overdue'],
    overdue: ['partial', 'paid'],
    paid: [],
    void: [],
  });
  // Todo lo que no está en la tabla, lanza.
  let invalidas = 0;
  for (const from of INVOICE_STATUSES) {
    for (const to of INVOICE_STATUSES) {
      if (canTransition(from, to)) continue;
      invalidas++;
      assert.throws(
        () => transitionInvoice({ status: from, total: '100.00', paidAmount: '0.00' }, to, { paidAmount: '100.00' }),
        (e: unknown) => e instanceof InvalidTransition && e.from === from && e.to === to && /No se puede pasar/.test(e.message),
      );
    }
  }
  assert.equal(invalidas, 36 - 10);
});

test('draft → sent y draft|sent → void no tocan el pago', () => {
  const inv = { status: 'draft' as const, total: '3100000.00', paidAmount: '0.00' };
  assert.deepEqual(transitionInvoice(inv, 'sent'), { status: 'sent', paidAmount: '0.00', setsPaidAt: false });
  assert.deepEqual(transitionInvoice(inv, 'void'), { status: 'void', paidAmount: '0.00', setsPaidAt: false });
  assert.deepEqual(transitionInvoice({ ...inv, status: 'sent' }, 'void'), { status: 'void', paidAmount: '0.00', setsPaidAt: false });
});

test('paid exige el total exacto', () => {
  const inv = { status: 'sent' as const, total: '3100000.00', paidAmount: '0.00' };
  assert.deepEqual(transitionInvoice(inv, 'paid', { paidAmount: '3100000.00' }), { status: 'paid', paidAmount: '3100000.00', setsPaidAt: true });
  assert.deepEqual(transitionInvoice(inv, 'paid'), { status: 'paid', paidAmount: '3100000.00', setsPaidAt: true });
  assert.throws(() => transitionInvoice(inv, 'paid', { paidAmount: '3099999.99' }), /igual al total/);
  assert.throws(() => transitionInvoice(inv, 'paid', { paidAmount: '3100000.01' }), /igual al total/);
});

test('partial exige 0 < monto < total', () => {
  const inv = { status: 'sent' as const, total: '3100000.00', paidAmount: '0.00' };
  assert.deepEqual(transitionInvoice(inv, 'partial', { paidAmount: '1000000.00' }), { status: 'partial', paidAmount: '1000000.00', setsPaidAt: true });
  assert.throws(() => transitionInvoice(inv, 'partial'), /necesita el monto/);
  assert.throws(() => transitionInvoice(inv, 'partial', { paidAmount: '0.00' }), /mayor que cero/);
  assert.throws(() => transitionInvoice(inv, 'partial', { paidAmount: '3100000.00' }), /menor que el total/);
  // overdue → partial → paid
  const p = transitionInvoice({ ...inv, status: 'overdue' }, 'partial', { paidAmount: '500000.00' });
  assert.equal(p.status, 'partial');
  assert.equal(transitionInvoice({ ...inv, status: 'partial', paidAmount: '500000.00' }, 'paid').status, 'paid');
});

test('los mensajes de error están en español y nombran los estados', () => {
  assert.throws(
    () => transitionInvoice({ status: 'paid', total: '1.00', paidAmount: '1.00' }, 'sent'),
    /No se puede pasar una factura de «Pagada» a «Enviada»\./,
  );
});

// ---------------------------------------------------------------- estado derivado

test('overdue se deriva: vence hoy no es vencida, venció ayer sí', () => {
  const hoy = '2026-09-21';
  assert.equal(deriveStatus({ status: 'sent', dueOn: '2026-09-21' }, hoy), 'sent');
  assert.equal(deriveStatus({ status: 'sent', dueOn: '2026-09-20' }, hoy), 'overdue');
  assert.equal(deriveStatus({ status: 'partial', dueOn: '2026-08-11' }, hoy), 'overdue');
  assert.equal(deriveStatus({ status: 'sent', dueOn: '2026-09-28' }, hoy), 'sent');
  // draft, paid y void no vencen.
  assert.equal(deriveStatus({ status: 'draft', dueOn: '2026-01-01' }, hoy), 'draft');
  assert.equal(deriveStatus({ status: 'paid', dueOn: '2026-01-01' }, hoy), 'paid');
  assert.equal(deriveStatus({ status: 'void', dueOn: '2026-01-01' }, hoy), 'void');
  // Cambio de año: el orden lexicográfico ISO sigue siendo correcto.
  assert.equal(deriveStatus({ status: 'sent', dueOn: '2025-12-31' }, '2026-01-01'), 'overdue');
  assert.throws(() => deriveStatus({ status: 'sent', dueOn: '21/09/2026' }, hoy), /YYYY-MM-DD/);
});

test('aging_bucket replica la vista receivables y cubre draft y void', () => {
  const hoy = '2026-09-21';
  assert.equal(agingBucket({ status: 'sent', dueOn: '2026-10-14' }, hoy), 'al_dia');       // +23
  assert.equal(agingBucket({ status: 'sent', dueOn: '2026-09-28' }, hoy), 'vence_pronto'); // +7
  assert.equal(agingBucket({ status: 'sent', dueOn: '2026-09-29' }, hoy), 'al_dia');       // +8
  assert.equal(agingBucket({ status: 'sent', dueOn: '2026-09-21' }, hoy), 'vence_pronto'); // hoy
  assert.equal(agingBucket({ status: 'sent', dueOn: '2026-08-11' }, hoy), 'vencida');      // −41
  assert.equal(agingBucket({ status: 'paid', dueOn: '2026-08-11' }, hoy), 'pagada');
  assert.equal(agingBucket({ status: 'draft', dueOn: '2026-08-11' }, hoy), 'borrador');
  assert.equal(agingBucket({ status: 'void', dueOn: '2026-08-11' }, hoy), 'anulada');
});

test('aritmética de fechas en UTC', () => {
  assert.equal(daysBetween('2026-09-21', '2026-10-14'), 23);
  assert.equal(daysBetween('2026-09-21', '2026-08-11'), -41);
  assert.equal(addDays('2026-09-21', 30), '2026-10-21');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// ---------------------------------------------------------------- numeración

test('la numeración sigue el formato del seed 0003', () => {
  assert.equal(nextInvoiceNumber(2026, 3), 'FV-2026-004');
  assert.equal(nextInvoiceNumber(2026, 0), 'FV-2026-001');
  assert.equal(nextInvoiceNumber(2026, 11), 'FV-2026-012');
  assert.equal(nextInvoiceNumber(2026, 999), 'FV-2026-1000');
  assert.deepEqual(parseInvoiceNumber('FV-2026-011'), { year: 2026, seq: 11 });
  assert.deepEqual(parseInvoiceNumber('FV-2026-1000'), { year: 2026, seq: 1000 });
  assert.equal(parseInvoiceNumber('COT-2026-014'), null);
  assert.equal(parseInvoiceNumber('FV-26-1'), null);
  assert.throws(() => nextInvoiceNumber(2026, -1), /Secuencia inválida/);
});

// ---------------------------------------------------------------- pagos (FIN-2)

/** Lo que el seed 0003 deja en FV-2026-010: enviada, 3 100 000, nada cobrado. */
const FV_010 = { status: 'sent' as const, total: '3100000.00', paidAmount: '0.00' };

/** El día y el instante de un cobro de hoy, con la forma que la consulta le pasa a core. */
const HOY = { receivedOn: '2026-09-23', receivedAt: '2026-09-23T15:00:00Z', today: '2026-09-23' };

test('un pago parcial deja la factura en partial y no toca paid_at', () => {
  const r = applyPayment(FV_010, { amount: '1000000', ...HOY });
  assert.equal(r.status, 'partial');
  assert.equal(r.amount, '1000000.00');
  assert.equal(r.paidAmount, '1000000.00');
  assert.equal(r.outstanding, '2100000.00');
  assert.equal(r.paidAt, null, 'un abono no es «pagada el …»');
});

test('el pago que completa el total la deja pagada, con paid_at en el instante del cobro', () => {
  const r = applyPayment({ ...FV_010, paidAmount: '1000000.00' }, { amount: '2100000', ...HOY });
  assert.equal(r.status, 'paid');
  assert.equal(r.paidAmount, '3100000.00');
  assert.equal(r.outstanding, '0.00');
  assert.equal(r.paidAt, '2026-09-23T15:00:00Z');
});

test('los centavos cuadran: tres abonos que suman el total la dejan pagada', () => {
  const a = applyPayment(FV_010, { amount: '1033333.33', ...HOY });
  const b = applyPayment({ ...FV_010, status: 'partial', paidAmount: a.paidAmount }, { amount: '1033333.33', ...HOY });
  const c = applyPayment({ ...FV_010, status: 'partial', paidAmount: b.paidAmount }, { amount: '1033333.34', ...HOY });
  assert.equal(c.paidAmount, '3100000.00');
  assert.equal(c.status, 'paid');
});

test('se cobra sobre enviada, parcial y vencida; nunca sobre borrador, pagada o anulada', () => {
  assert.deepEqual([...PAYABLE_STATUSES], ['sent', 'partial', 'overdue']);
  for (const status of ['sent', 'partial', 'overdue'] as const) {
    assert.equal(applyPayment({ ...FV_010, status }, { amount: '100', ...HOY }).status, 'partial');
  }
  for (const status of ['draft', 'paid', 'void'] as const) {
    assert.throws(() => applyPayment({ ...FV_010, status }, { amount: '100', ...HOY }), (err: unknown) => {
      assert.ok(err instanceof InvoiceNotPayable);
      assert.equal(err.code, 'InvoiceNotPayable');
      assert.match(err.messageEs, /no admite pagos/);
      return true;
    });
  }
});

test('un pago de cero, negativo o mayor que el saldo se rechaza', () => {
  assert.throws(() => applyPayment(FV_010, { amount: '0', ...HOY }), PaymentAmountInvalid);
  assert.throws(() => applyPayment(FV_010, { amount: '-100', ...HOY }), PaymentAmountInvalid);
  assert.throws(() => applyPayment(FV_010, { amount: '3100000.01', ...HOY }), (err: unknown) => {
    assert.ok(err instanceof PaymentExceedsOutstanding);
    assert.equal(err.outstanding, '3100000.00');
    assert.match(err.messageEs, /queda por cobrar/);
    return true;
  });
  // Sobre una factura que ya lleva un abono, el saldo del mensaje es el que queda.
  assert.throws(
    () => applyPayment({ ...FV_010, status: 'partial', paidAmount: '3000000.00' }, { amount: '100000.01', ...HOY }),
    (err: unknown) => err instanceof PaymentExceedsOutstanding && err.outstanding === '100000.00',
  );
});

test('un cobro fechado mañana no ha ocurrido', () => {
  assert.throws(
    () => applyPayment(FV_010, { amount: '100', receivedOn: '2026-09-24', receivedAt: '2026-09-24T15:00:00Z', today: '2026-09-23' }),
    PaymentDateInFuture,
  );
  // Hoy sí.
  assert.equal(applyPayment(FV_010, { amount: '100', ...HOY }).status, 'partial');
});

test('MONTO_MAXIMO es el máximo de numeric(14,2) y se comprueba antes de llegar a Postgres', () => {
  assert.equal(MONTO_MAXIMO, '999999999999.99');
  const enorme = { status: 'sent' as const, total: '999999999999.99', paidAmount: '0.00' };
  assert.equal(applyPayment(enorme, { amount: '999999999999.99', ...HOY }).status, 'paid');
  assert.throws(() => applyPayment(enorme, { amount: '1000000000000.00', ...HOY }), (err: unknown) => {
    assert.ok(err instanceof AmountOutOfRange);
    assert.match(err.messageEs, /999999999999\.99/);
    return true;
  });
});

test('un monto que no es un decimal no llega a la base', () => {
  assert.throws(() => applyPayment(FV_010, { amount: '1.000.000', ...HOY }), /Monto inválido/);
  assert.throws(() => applyPayment(FV_010, { amount: '', ...HOY }), /Monto inválido/);
});

// ------------------------------------------------------- reserva de impuestos

test('la reserva es el porcentaje del cobro, redondeado al centavo mitad hacia arriba', () => {
  // La cifra del seed 0003 §6: 3 700 000 al 11 % → 407 000.
  assert.equal(taxReserveFor('3700000.00', '0.11'), '407000.00');
  assert.equal(taxReserveFor('4700000.00', '0.1100'), '517000.00');
  // Half-up en el centavo: 0,055 → 0,06, no 0,05.
  assert.equal(taxReserveFor('0.50', '0.11'), '0.06');
  assert.equal(taxReserveFor('1000000.00', '0.115'), '115000.00');
});

test('la tasa sale de settings.finanzas.reserva_pct, y una ausencia no es un cero', () => {
  assert.equal(reserveRateFrom(11), '0.11');
  assert.equal(reserveRateFrom('11'), '0.11');
  assert.equal(reserveRateFrom('11,5'), '0.115');
  assert.equal(reserveRateFrom('11.55'), '0.1155', 'cuatro decimales es lo que guarda numeric(6,4)');
  assert.equal(reserveRateFrom(100), '1');
  // Ausente o cero: este espacio no aparta y no se escribe ninguna fila.
  assert.equal(reserveRateFrom(undefined), null);
  assert.equal(reserveRateFrom(null), null);
  assert.equal(reserveRateFrom(0), null);
  assert.equal(reserveRateFrom('0'), null);
  assert.equal(reserveRateFrom('0.00'), null);
  // Presente pero roto: se ve, no se supone.
  // Más de dos decimales en el porcentaje no caben en numeric(6,4): el
  // apartado no correspondería a la tasa escrita junto a él.
  for (const roto of ['once', -1, 101, '150', {}, NaN, true, '11.555', 11.5555]) {
    assert.throws(() => reserveRateFrom(roto), TaxReserveRateInvalid, `debería fallar con ${JSON.stringify(roto)}`);
  }
});

test('el período fiscal es el trimestre del día del cobro, con los bordes bien', () => {
  assert.equal(reservePeriod('2026-01-01'), '2026-Q1');
  assert.equal(reservePeriod('2026-03-31'), '2026-Q1');
  assert.equal(reservePeriod('2026-04-01'), '2026-Q2');
  assert.equal(reservePeriod('2026-06-30'), '2026-Q2');
  assert.equal(reservePeriod('2026-07-01'), '2026-Q3');
  assert.equal(reservePeriod('2026-09-30'), '2026-Q3');
  assert.equal(reservePeriod('2026-10-01'), '2026-Q4');
  assert.equal(reservePeriod('2026-12-31'), '2026-Q4');
  assert.throws(() => reservePeriod('2026-13-01'), /Mes inválido/);
  assert.throws(() => reservePeriod('31/12/2026'), /YYYY-MM-DD/);
});

test('el trimestre es el de la zona del workspace, no el de UTC', () => {
  // 1 de enero a la 01:00 UTC son las 20:00 del 31 de diciembre en Bogotá:
  // el creador lo declara en 2026-Q4, no en 2027-Q1.
  const instante = new Date('2027-01-01T01:00:00Z');
  assert.equal(reservePeriod(hoyEnZona('America/Bogota', instante)), '2026-Q4');
  assert.equal(reservePeriod(hoyEnZona('UTC', instante)), '2027-Q1');
});

test('los métodos de pago son una lista cerrada y el del seed está en ella', () => {
  assert.deepEqual([...PAYMENT_METHODS], ['transferencia', 'efectivo', 'pse', 'tarjeta', 'otro']);
  assert.equal(isPaymentMethod('transferencia'), true, 'es el método del seed 0003 §6');
  assert.equal(isPaymentMethod('bitcoin'), false);
  for (const m of PAYMENT_METHODS) assert.ok(PAYMENT_METHOD_LABEL_ES[m].length > 0);
});

test('todos los errores de pago son InvoiceError, con messageEs en español', () => {
  const errores = [
    new InvoiceNotPayable('draft'),
    new PaymentAmountInvalid('0'),
    new PaymentExceedsOutstanding('100.00'),
    new AmountOutOfRange('1000000000000.00'),
    new PaymentDateInFuture('2026-09-24', '2026-09-23'),
    new InvoicePaymentConflict('0.00', '500000.00'),
    new TaxReserveRateInvalid('once'),
  ];
  for (const err of errores) {
    assert.ok(err instanceof InvoiceError, `${err.name} debería ser InvoiceError`);
    assert.equal(err.messageEs, err.message);
    assert.equal(err.name, err.code);
    assert.match(err.messageEs, /[áéíóúñ¿]|no |la |el /i, `${err.name} tiene que hablar español`);
  }
});
