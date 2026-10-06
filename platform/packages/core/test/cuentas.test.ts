/**
 * RES-3 · cómo se nombra una cuenta y el aviso de una cuenta rota, en un
 * solo sitio para el worker (la campana) y la web (el Resumen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel, arroba, connectionErrorSeverity, connectionErrorTitle } from '../src/cuentas.ts';

test('arroba: una sola, aunque el handle ya la traiga', () => {
  assert.equal(arroba('laura.cocinafacil'), '@laura.cocinafacil');
  assert.equal(arroba('@@laura'), '@laura');
  assert.equal(arroba(' laura '), '@laura');
});

test('accountLabel: la red y el @, o solo la red si no hay @', () => {
  assert.equal(accountLabel('TikTok', 'laura.cocinafacil'), 'TikTok @laura.cocinafacil');
  assert.equal(accountLabel('TikTok', '@laura'), 'TikTok @laura');
  assert.equal(accountLabel('Facebook', null), 'Facebook');
  assert.equal(accountLabel('Facebook', '  '), 'Facebook');
  assert.equal(accountLabel('Facebook', '@'), 'Facebook');
});

test('el título de la cuenta rota dice qué pasó y no promete cómo se arregla', () => {
  assert.equal(connectionErrorTitle('Facebook', 'lauracocinafacil', 'reauth'), 'Facebook dejó de darnos las cifras de @lauracocinafacil');
  assert.equal(connectionErrorTitle('Facebook', null, 'reauth'), 'Facebook dejó de darnos las cifras de tu cuenta');
  assert.equal(connectionErrorTitle('TikTok', '@laura', 'unreadable'), 'No podemos leer tu cuenta de TikTok @laura');
  assert.equal(connectionErrorTitle('TikTok', undefined, 'unreadable'), 'No podemos leer tu cuenta de TikTok');
  for (const kind of ['reauth', 'unreadable'] as const) {
    assert.doesNotMatch(connectionErrorTitle('Facebook', 'x', kind), /vuelve a conectar|reautoriza/i);
  }
});

test('sin token es crítico; una cuenta que no se lee, aviso', () => {
  assert.equal(connectionErrorSeverity('reauth'), 'critical');
  assert.equal(connectionErrorSeverity('unreadable'), 'warning');
});
