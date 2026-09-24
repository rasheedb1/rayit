/**
 * VEN-10 · la programación de una cadencia: días hábiles, zona horaria,
 * dispersión determinista, siguiente hueco hábil, reintentos y
 * calentamiento. Todo puro: el reloj lo pone la prueba.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessDays, clampToWindow, isInsideWindow, nextBusinessSlot, nextRetryAt, nextWindowSlot, parseClock, planSteps,
  retryDelayMs, seededUnit, shiftFollowingSteps, spreadSeconds, stepClockSeconds, warmupDailyCap, zonedInstant, zonedParts,
  MAX_SEND_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS, type PlanStep,
} from '../src/outreach/schedule.ts';

const BOGOTA = 'America/Bogota';
const MADRID = 'Europe/Madrid';
const W = { start: '09:00', end: '17:00' };

/** La hora local 'HH:MM' de un instante en la zona. */
function localClock(at: Date, tz: string): string {
  const { seconds } = zonedParts(at, tz);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}
function localDay(at: Date, tz: string): string {
  const { date } = zonedParts(at, tz);
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

test('zonedInstant y zonedParts son inversos, también con cambio de horario', () => {
  // Madrid pasa a horario de invierno el 25-oct-2026 a las 03:00.
  for (const [d, s] of [[{ year: 2026, month: 10, day: 24 }, 10 * 3600], [{ year: 2026, month: 10, day: 26 }, 10 * 3600]] as const) {
    const at = zonedInstant(d, s, MADRID);
    assert.deepEqual(zonedParts(at, MADRID), { date: d, seconds: s });
  }
  assert.equal(zonedInstant({ year: 2026, month: 10, day: 24 }, 10 * 3600, MADRID).toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(zonedInstant({ year: 2026, month: 10, day: 26 }, 10 * 3600, MADRID).toISOString(), '2026-10-26T09:00:00.000Z');
});

test('días hábiles: el viernes más uno es el lunes; el sábado cuenta desde el lunes', () => {
  assert.deepEqual(addBusinessDays({ year: 2026, month: 9, day: 25 }, 1), { year: 2026, month: 9, day: 28 });
  assert.deepEqual(addBusinessDays({ year: 2026, month: 9, day: 26 }, 0), { year: 2026, month: 9, day: 28 });
  assert.deepEqual(addBusinessDays({ year: 2026, month: 9, day: 23 }, 9), { year: 2026, month: 10, day: 6 });
  assert.throws(() => addBusinessDays({ year: 2026, month: 9, day: 23 }, -1), RangeError);
});

test('la dispersión es determinista y cae en su rango', () => {
  assert.equal(seededUnit('abc'), seededUnit('abc'));
  assert.notEqual(seededUnit('abc'), seededUnit('abd'));
  for (let i = 0; i < 200; i++) {
    const s = spreadSeconds(`e-${i}`, 40);
    assert.ok(s >= 0 && s < 40 * 60, `fuera de rango: ${s}`);
  }
  assert.equal(spreadSeconds('x', 0), 0);
});

test('la ventana encierra la hora: antes va al inicio, después da la vuelta', () => {
  assert.equal(clampToWindow(parseClock('07:00'), W), parseClock('09:00'));
  assert.equal(clampToWindow(parseClock('10:15'), W), parseClock('10:15'));
  assert.equal(clampToWindow(parseClock('17:20'), W), parseClock('09:20'));
  assert.throws(() => clampToWindow(0, { start: '17:00', end: '09:00' }), RangeError);
  const s = stepClockSeconds({ id: 'p', scheduledTime: '16:50' }, { seed: 'e', window: W, spreadMinutes: 40 });
  assert.ok(s >= parseClock('09:00') && s < parseClock('17:00'));
});

const TRES: PlanStep[] = [
  { id: 's0', dayOffset: 0, orderInDay: 0, scheduledTime: '09:30' },
  { id: 's1', dayOffset: 1, orderInDay: 0, scheduledTime: '10:00' },
  { id: 's3', dayOffset: 3, orderInDay: 0, scheduledTime: '09:30' },
];

test('planSteps: tres pasos en días hábiles, a su hora local de Bogotá, dentro de la ventana', () => {
  // Miércoles 23-sep-2026, 07:00 en Bogotá (12:00 UTC).
  const plan = planSteps(TRES, { enrolledAt: new Date('2026-09-23T12:00:00Z'), timeZone: BOGOTA, seed: 'enr-1', window: W });
  assert.deepEqual(plan.map((p) => localDay(p.at, BOGOTA)), ['2026-09-23', '2026-09-24', '2026-09-28']);
  for (const p of plan) assert.ok(isInsideWindow(p.at, BOGOTA, W), `${p.stepId} fuera de la ventana: ${p.at.toISOString()}`);
  // Misma semilla, mismo plan.
  const otra = planSteps(TRES, { enrolledAt: new Date('2026-09-23T12:00:00Z'), timeZone: BOGOTA, seed: 'enr-1', window: W });
  assert.deepEqual(otra, plan);
  // Otra semilla, otras horas (la dispersión separa a los contactos).
  const b = planSteps(TRES, { enrolledAt: new Date('2026-09-23T12:00:00Z'), timeZone: BOGOTA, seed: 'enr-2', window: W });
  assert.notDeepEqual(b.map((p) => p.at.getTime()), plan.map((p) => p.at.getTime()));
});

test('planSteps: enrolado tarde, toda la cadencia se corre un día hábil', () => {
  // Viernes 25-sep, 18:00 en Bogotá: el día 0 pasa al lunes y el día 1 al martes.
  const plan = planSteps(TRES, { enrolledAt: new Date('2026-09-25T23:00:00Z'), timeZone: BOGOTA, seed: 'e', window: W });
  assert.deepEqual(plan.map((p) => localDay(p.at, BOGOTA)), ['2026-09-28', '2026-09-29', '2026-10-01']);
});

test('planSteps: los instantes son estrictamente crecientes aunque dos pasos compartan hora', () => {
  const mismos: PlanStep[] = [
    { id: 'a', dayOffset: 0, orderInDay: 0, scheduledTime: '10:00' },
    { id: 'b', dayOffset: 0, orderInDay: 1, scheduledTime: '10:00' },
  ];
  const plan = planSteps(mismos, { enrolledAt: new Date('2026-09-23T12:00:00Z'), timeZone: BOGOTA, seed: 'e', spreadMinutes: 0, window: W });
  assert.equal(plan[1]!.at.getTime() - plan[0]!.at.getTime(), 5 * 60 * 1000);
  assert.throws(() => planSteps(mismos, { enrolledAt: new Date(), timeZone: 'Bogota', seed: 'e' }), RangeError);
});

test('nextBusinessSlot: viernes 15:10 → lunes 15:10; fuera de la ventana, dentro de ella', () => {
  const lunes = nextBusinessSlot(new Date('2026-09-25T20:10:00Z'), BOGOTA, W);
  assert.equal(localDay(lunes, BOGOTA), '2026-09-28');
  assert.equal(localClock(lunes, BOGOTA), '15:10');
  const tarde = nextBusinessSlot(new Date('2026-09-23T23:30:00Z'), BOGOTA, W); // miércoles 18:30
  assert.equal(localDay(tarde, BOGOTA), '2026-09-24');
  assert.equal(localClock(tarde, BOGOTA), '10:30');
});

test('los reintentos esperan cada vez más, hasta un tope, y se acaban en el quinto', () => {
  const d = [1, 2, 3, 4].map((n) => retryDelayMs(n, 't'));
  for (let i = 1; i < d.length; i++) assert.ok(d[i]! > d[i - 1]!, `no crece: ${d.join(', ')}`);
  assert.ok(d[0]! >= RETRY_BASE_MS && d[0]! <= RETRY_BASE_MS * 1.2);
  assert.ok(retryDelayMs(12, 't') <= RETRY_MAX_MS * 1.2);
  const now = new Date('2026-09-23T15:00:00Z');
  assert.ok(nextRetryAt(now, 1, 't')!.getTime() > now.getTime());
  assert.equal(nextRetryAt(now, MAX_SEND_ATTEMPTS, 't'), null);
  assert.throws(() => retryDelayMs(0, 't'), RangeError);
});

test('nextWindowSlot: dentro de la ventana no cambia; de madrugada, hoy al abrir; de noche o en fin de semana, el siguiente hábil', () => {
  const dentro = new Date('2026-09-23T16:00:00Z'); // miércoles 11:00 en Bogotá
  assert.equal(nextWindowSlot(dentro, BOGOTA, W), dentro);
  const madrugada = nextWindowSlot(new Date('2026-09-22T08:00:00Z'), BOGOTA, W); // martes 03:00
  assert.equal(localDay(madrugada, BOGOTA), '2026-09-22');
  assert.equal(localClock(madrugada, BOGOTA), '09:00');
  const noche = nextWindowSlot(new Date('2026-09-23T23:30:00Z'), BOGOTA, W); // miércoles 18:30
  assert.equal(localDay(noche, BOGOTA), '2026-09-24');
  assert.equal(localClock(noche, BOGOTA), '09:00');
  const sabado = nextWindowSlot(new Date('2026-09-26T15:00:00Z'), BOGOTA, W);
  assert.equal(localDay(sabado, BOGOTA), '2026-09-28');
  // El cierre es exclusivo: a las 17:00 ya no sale.
  assert.equal(localDay(nextWindowSlot(new Date('2026-09-25T22:00:00Z'), BOGOTA, W), BOGOTA), '2026-09-28');
  // Con semilla, la apertura se dispersa (determinista) sin salirse de la ventana.
  const a = nextWindowSlot(new Date('2026-09-22T08:00:00Z'), BOGOTA, W, { seed: 'toque-1' });
  const b = nextWindowSlot(new Date('2026-09-22T08:00:00Z'), BOGOTA, W, { seed: 'toque-1' });
  assert.equal(a.getTime(), b.getTime());
  assert.match(localClock(a, BOGOTA), /^09:[0-2]\d$/);
  assert.ok(isInsideWindow(a, BOGOTA, W));
  // En Madrid, con cambio de horario el domingo 25 de octubre: el lunes al abrir, hora local.
  const madrid = nextWindowSlot(new Date('2026-10-24T10:00:00Z'), MADRID, W);
  assert.equal(localDay(madrid, MADRID), '2026-10-26');
  assert.equal(localClock(madrid, MADRID), '09:00');
});

test('nextRetryAt con la zona: el reintento de un viernes a las 16:50 sale el lunes, dentro de la ventana', () => {
  const viernes = new Date('2026-09-25T21:50:00Z'); // viernes 16:50 en Bogotá
  const crudo = nextRetryAt(viernes, 4, 'toque')!;
  assert.ok(!isInsideWindow(crudo, BOGOTA, W), 'sin zona, 64 minutos después ya es de noche');
  const r = nextRetryAt(viernes, 4, 'toque', { timeZone: BOGOTA, window: W })!;
  assert.equal(localDay(r, BOGOTA), '2026-09-28');
  assert.ok(isInsideWindow(r, BOGOTA, W));
  // Un reintento que cae dentro no se mueve.
  const temprano = new Date('2026-09-23T15:00:00Z'); // miércoles 10:00
  assert.equal(nextRetryAt(temprano, 1, 'toque', { timeZone: BOGOTA, window: W })!.getTime(), nextRetryAt(temprano, 1, 'toque')!.getTime());
  assert.equal(nextRetryAt(temprano, MAX_SEND_ATTEMPTS, 'toque', { timeZone: BOGOTA }), null);
});

test('shiftFollowingSteps: el paso que va detrás se corre con el que se movió, en días hábiles y sin adelantarse', () => {
  const at = (iso: string) => new Date(iso);
  // El paso 1 (día 0) pasó del viernes 25 al lunes 28 a las 16:50; el 2 (día 1) estaba el viernes 25 a las 11:00
  // y el 3 (día 4) el miércoles 30 a las 10:00.
  const moved = { dayOffset: 0, orderInDay: 0, at: at('2026-09-28T21:50:00Z') };
  const r = shiftFollowingSteps(moved, [
    { id: 's2', dayOffset: 1, orderInDay: 0, at: at('2026-09-25T16:00:00Z') },
    { id: 's3', dayOffset: 4, orderInDay: 0, at: at('2026-09-30T15:00:00Z') },
    { id: 's0', dayOffset: 0, orderInDay: 0, at: at('2026-09-20T15:00:00Z') },
  ], BOGOTA, W);
  const byId = new Map(r.map((x) => [x.id, x.at]));
  assert.equal(localDay(byId.get('s2')!, BOGOTA), '2026-09-29', 'un día hábil después del lunes');
  assert.equal(localClock(byId.get('s2')!, BOGOTA), '11:00', 'con su hora de reloj');
  assert.equal(localDay(byId.get('s3')!, BOGOTA), '2026-10-02', 'cuatro días hábiles después del lunes');
  assert.ok(!byId.has('s0'), 'lo que va antes no se toca');
  // Lo que ya iba después no se adelanta.
  const lejos = shiftFollowingSteps(moved, [{ id: 'x', dayOffset: 1, orderInDay: 0, at: at('2026-10-20T15:00:00Z') }], BOGOTA, W);
  assert.deepEqual(lejos, []);
  // Mismo día, orden siguiente: al menos cinco minutos después.
  const mismo = shiftFollowingSteps(moved, [{ id: 'y', dayOffset: 0, orderInDay: 1, at: at('2026-09-25T15:00:00Z') }], BOGOTA, W);
  assert.ok(mismo[0]!.at.getTime() >= moved.at.getTime() + 5 * 60 * 1000);
});

test('calentamiento: sube en línea recta hasta el tope', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  const cap = (days: number) => warmupDailyCap({ cap: 40, warmupStartedAt: start, warmupDays: 14, now: new Date(start.getTime() + days * 86_400_000) });
  assert.equal(cap(0), 3);
  assert.ok(cap(7) > cap(0) && cap(7) < 40);
  assert.equal(cap(14), 40);
  assert.equal(warmupDailyCap({ cap: 40, warmupStartedAt: null, warmupDays: 14, now: start }), 40);
  assert.equal(warmupDailyCap({ cap: 0, warmupStartedAt: start, warmupDays: 14, now: start }), 0);
});
