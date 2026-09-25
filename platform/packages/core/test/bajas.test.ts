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

test('una respuesta que pide OTRO camino no es baja: con un correo o un «escríbeme», la decide el clasificador', () => {
  for (const t of [
    'No me escribas por LinkedIn, escríbeme a partnerships@marca.com',
    'No me escribas por aquí; escríbeme al correo y lo vemos.',
    'Please stop messaging me here, write to me at hello@brand.co instead.',
    "Don't contact me on Instagram. My email is ana@marca.com.br",
    'Não me escreva por aqui, escreva para parcerias@marca.com.br',
    'Dame de baja de LinkedIn y habla con Marta, de marketing.',
  ]) {
    assert.equal(looksLikeOptOut(t), false, t);
  }
});

test('la baja se lee en lo que escribió la persona, no en lo que cita ni en su firma', () => {
  // La baja sigue siendo baja aunque la cita traiga direcciones (cabecera de Gmail, de Outlook) o la firma, un correo.
  assert.equal(looksLikeOptOut('Por favor no me escribas más.\n\nEl lun, 22 sept 2026 a las 10:00, Laura <laura@oncue.test> escribió:\n> Hola Marta, ¿hablamos?'), true);
  assert.equal(looksLikeOptOut('Please remove me from your list.\n\nOn Mon, Sep 22, 2026 at 10:00 AM Laura <\nlaura@oncue.test> wrote:\n> Hi Marta'), true);
  assert.equal(looksLikeOptOut('Unsubscribe.\n-- \nMarta Ríos · marta@marca.test'), true);
  assert.equal(looksLikeOptOut('Dame de baja.\n\n-----Mensaje original-----\nDe: Laura <laura@oncue.test>'), true);
  // Y el pie de NUESTRO mensaje citado («date de baja aquí») no convierte en baja una respuesta interesada.
  assert.equal(looksLikeOptOut('¡Nos interesa! ¿Cuándo hablamos?\n\n> Si no quieres recibir más, dame de baja aquí.'), false);
  assert.equal(looksLikeOptOut('> no me escribas más'), false, 'solo cita');
});
