import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeOptOut, normalizeReply } from '../src/bajas.ts';

test('normalizeReply: minúsculas, sin tildes ni signos', () => {
  assert.equal(normalizeReply('¡NO me ESCRIBAS más!'), 'no me escribas mas');
});

test('looksLikeOptOut reconoce la baja explícita en español, inglés y portugués', () => {
  for (const t of [
    'Hola, por favor no me escribas más.', 'Dame de baja, gracias', 'Please remove me from your list.', 'Unsubscribe',
    'STOP', "Don't contact me again", 'Por favor, não me escreva mais.',
  ]) {
    assert.equal(looksLikeOptOut(t), true, t);
  }
});

test('looksLikeOptOut no marca lo ambiguo ni lo interesado: eso lo decide el clasificador', () => {
  for (const t of [
    '¡Hola! Nos interesa, ¿tienes media kit?', 'Ahora no, escríbeme en enero.', 'No nos interesa por ahora.',
    'Estoy fuera de la oficina hasta el lunes.', 'Stop by our office next week', '', null,
  ]) {
    assert.equal(looksLikeOptOut(t), false, String(t));
  }
});
