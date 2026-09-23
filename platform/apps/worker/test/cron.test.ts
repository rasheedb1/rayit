/**
 * WRK · el último tick de un cron (runner/cron.ts), que decide qué está
 * vencido en --once. Sin base de datos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CronError, lastTick, parseCron } from '../src/runner/cron.ts';

const tick = (expr: string, now: string) => lastTick(expr, new Date(now))?.toISOString() ?? null;

test('cada 15 minutos: el cuarto de hora que acaba de pasar', () => {
  assert.equal(tick('*/15 * * * *', '2026-09-23T10:07:30Z'), '2026-09-23T10:00:00.000Z');
  assert.equal(tick('*/15 * * * *', '2026-09-23T10:15:00Z'), '2026-09-23T10:15:00.000Z', 'el minuto exacto cuenta');
});

test('diario a las 05:00: antes de la hora es el de ayer; a la hora, el de hoy', () => {
  assert.equal(tick('0 5 * * *', '2026-09-23T04:59:59Z'), '2026-09-22T05:00:00.000Z');
  assert.equal(tick('0 5 * * *', '2026-09-23T05:00:00Z'), '2026-09-23T05:00:00.000Z');
  assert.equal(tick('30 7 * * *', '2026-09-01T00:10:00Z'), '2026-08-31T07:30:00.000Z', 'cruza el mes');
});

test('cada 6 horas y semanal (el lunes a las 02:00)', () => {
  assert.equal(tick('0 */6 * * *', '2026-09-23T13:00:00Z'), '2026-09-23T12:00:00.000Z');
  // 23-sep-2026 es miércoles: el lunes anterior es el 21.
  assert.equal(tick('0 2 * * 1', '2026-09-23T13:00:00Z'), '2026-09-21T02:00:00.000Z');
  assert.equal(tick('0 2 * * 7', '2026-09-23T13:00:00Z'), '2026-09-20T02:00:00.000Z', '7 es domingo, como 0');
});

test('listas, rangos con paso y la regla día-del-mes O día-de-la-semana', () => {
  assert.equal(tick('10,40 8-18/2 * * *', '2026-09-23T13:05:00Z'), '2026-09-23T12:40:00.000Z');
  // Día 13 o viernes: el viernes 18-sep llega antes que el 13-oct.
  assert.equal(tick('0 0 13 * 5', '2026-09-23T00:00:00Z'), '2026-09-18T00:00:00.000Z');
});

test('anual cabe en la búsqueda; un cron imposible devuelve null', () => {
  assert.equal(tick('0 0 1 1 *', '2026-09-23T00:00:00Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(tick('0 0 31 2 *', '2026-09-23T00:00:00Z'), null);
});

test('un cron mal escrito es CronError, no un tick inventado', () => {
  assert.throws(() => parseCron('61 * * * *'), CronError);
  assert.throws(() => parseCron('* * *'), CronError);
  assert.throws(() => parseCron('*/0 * * * *'), CronError);
  assert.throws(() => parseCron('a * * * *'), CronError);
});

test('nombres en inglés de días y meses, como en pg-boss', () => {
  assert.equal(tick('0 2 * * MON', '2026-09-23T13:00:00Z'), '2026-09-21T02:00:00.000Z');
  assert.equal(tick('0 0 1 JAN *', '2026-09-23T00:00:00Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(tick('0 9 * * mon-fri', '2026-09-20T12:00:00Z'), '2026-09-18T09:00:00.000Z', 'domingo 20 → viernes 18');
});

test('un campo que empieza por * no restringe el día (regla de Vixie cron)', () => {
  // `*/1` en día de la semana es «cualquiera»: manda el día del mes (13), no «13 o cualquier día».
  assert.equal(tick('0 0 13 * */1', '2026-09-23T00:00:00Z'), '2026-09-13T00:00:00.000Z');
});
