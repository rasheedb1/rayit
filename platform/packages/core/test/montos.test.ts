import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONTO_MAXIMO, excedeMontoMaximo } from '../src/montos.ts';

test('el tope es el mayor numeric(14,2)', () => {
  assert.equal(MONTO_MAXIMO, '999999999999.99');
  assert.equal(excedeMontoMaximo(MONTO_MAXIMO), false);
  assert.equal(excedeMontoMaximo('999999999999.994'), false, 'redondea al centavo, como la base');
  assert.equal(excedeMontoMaximo('5200000'), false);
  assert.equal(excedeMontoMaximo('0'), false);
});

test('una cifra de más, o un centavo de más, excede', () => {
  assert.equal(excedeMontoMaximo('1000000000000'), true, '13 cifras: el caso del pulido r8');
  assert.equal(excedeMontoMaximo('999999999999.995'), true);
  assert.equal(excedeMontoMaximo('-1000000000000'), true, 'el tope vale para los dos signos');
  assert.equal(excedeMontoMaximo('0000999999999999.99'), false, 'los ceros a la izquierda no cuentan');
  assert.equal(excedeMontoMaximo('9'.repeat(40)), true);
});

test('lo que no es un decimal no excede: eso lo dice la validación de formato', () => {
  assert.equal(excedeMontoMaximo(''), false);
  assert.equal(excedeMontoMaximo('abc'), false);
  assert.equal(excedeMontoMaximo('1e20'), false);
});
