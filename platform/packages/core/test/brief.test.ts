import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryKey } from '../src/brief.ts';

test('categoryKey: sin tildes, sin mayúsculas, sin signos ni espacios', () => {
  assert.equal(categoryKey('Suplementos'), 'suplementos');
  assert.equal(categoryKey('  SUPLEMENTOS '), 'suplementos');
  assert.equal(categoryKey('Bebidas alcohólicas'), 'bebidasalcoholicas');
  assert.equal(categoryKey('bebidas-alcohólicas'), 'bebidasalcoholicas');
  assert.equal(categoryKey('Crème & Café'), 'cremecafe');
});

test('categoryKey: lo que no tiene letras ni cifras es vacío (no es una categoría)', () => {
  assert.equal(categoryKey(''), '');
  assert.equal(categoryKey('  ·—  '), '');
});
