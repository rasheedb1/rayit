import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finDelDiaEnZona, hoyEnZona } from '../src/zonas.ts';

test('el fin del día es el de la zona del workspace, no el de UTC', () => {
  assert.equal(finDelDiaEnZona('2026-09-30', 'America/Bogota'), '2026-10-01T04:59:59.000Z');
  assert.equal(finDelDiaEnZona('2026-09-30', 'UTC'), '2026-09-30T23:59:59.000Z');
  assert.equal(finDelDiaEnZona('2026-09-30', 'Asia/Tokyo'), '2026-09-30T14:59:59.000Z');
  assert.equal(finDelDiaEnZona('2026-09-30', 'Europe/Madrid'), '2026-09-30T21:59:59.000Z');
});

test('con cambio de horario cuenta el desfase de ESE día', () => {
  // Madrid pasa a horario de invierno el 25 de octubre de 2026.
  assert.equal(finDelDiaEnZona('2026-10-25', 'Europe/Madrid'), '2026-10-25T22:59:59.000Z');
  assert.equal(finDelDiaEnZona('2026-03-08', 'America/New_York'), '2026-03-09T03:59:59.000Z');
});

test('una fecha o una zona que no existen lanzan', () => {
  assert.throws(() => finDelDiaEnZona('2026-02-30', 'UTC'));
  assert.throws(() => finDelDiaEnZona('30/09/2026', 'UTC'));
  assert.throws(() => finDelDiaEnZona('2026-09-30', 'Marte/Olympus'));
});

test('hoy en la zona: a las 02:00 UTC en Bogotá todavía es ayer', () => {
  const ahora = new Date('2026-10-01T02:00:00Z');
  assert.equal(hoyEnZona('America/Bogota', ahora), '2026-09-30');
  assert.equal(hoyEnZona('UTC', ahora), '2026-10-01');
});
