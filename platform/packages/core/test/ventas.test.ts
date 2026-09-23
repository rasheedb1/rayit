import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIsoDate } from '../src/campanas.ts';
import { isClockTime } from '../src/ventas.ts';

test('isClockTime: de 00:00 a 23:59, con dos cifras', () => {
  for (const ok of ['00:00', '09:30', '15:00', '23:59']) assert.equal(isClockTime(ok), true, ok);
  for (const no of ['24:00', '9:30', '09:60', '09:30:00', '', 'mañana']) assert.equal(isClockTime(no), false, no);
});

test('el día de la siguiente acción y de la actividad se valida con isIsoDate: el 30 de febrero no pasa', () => {
  // Date.parse('2026-02-30T00:00:00Z') no es NaN en V8 (lo corre a marzo):
  // por eso la consulta dejaba pasar esas fechas hasta Postgres.
  assert.equal(Number.isNaN(Date.parse('2026-02-30T00:00:00Z')), false);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-02-31'), false);
  assert.equal(isIsoDate('2028-02-29'), true, 'bisiesto');
});
