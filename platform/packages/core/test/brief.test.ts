import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefOfferLines, categoryKey, deliverablePromptName } from '../src/brief.ts';

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

test('briefOfferLines: los formatos por su nombre, sin repetir, y la ventana abierta por un lado', () => {
  assert.deepEqual(briefOfferLines({ deliverables: [], availabilityFrom: null, availabilityTo: null }), []);
  const [formatos] = briefOfferLines({ deliverables: ['tiktok', 'historia', 'historias', 'otro_formato'] });
  assert.equal(
    formatos,
    'Formatos que ofrece el creador: video de TikTok, historias de Instagram, otro formato. Si propones una colaboración, propón solo estos formatos.',
  );
  assert.match(briefOfferLines({ availabilityFrom: '2026-10-01' })[0]!, /desde el 2026-10-01/);
  assert.match(briefOfferLines({ availabilityTo: '2026-12-15' })[0]!, /hasta el 2026-12-15/);
  assert.equal(deliverablePromptName('short'), 'YouTube Short');
});
