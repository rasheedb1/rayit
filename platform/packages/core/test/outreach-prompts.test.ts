/**
 * CIM-7 · los prompts de outreach van incrustados (prompts.gen.ts) para
 * que el turno del worker, empaquetado en Next, no tenga que leer un
 * archivo por ruta. Esta prueba falla si la copia y los .md divergen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPrompt } from '../src/outreach/generate.ts';
import { PROMPTS } from '../src/outreach/prompts.gen.ts';
// @ts-expect-error: script .mjs sin tipos; se importa para comparar con lo que generaría.
import { GENERATED, PROMPT_NAMES, render } from '../scripts/embed-prompts.mjs';

test('prompts.gen.ts es exactamente lo que genera embed-prompts.mjs con los .md de hoy (si falla: make core.prompts)', () => {
  assert.equal(readFileSync(GENERATED, 'utf8'), render());
});

test('cada prompt incrustado es, carácter a carácter, su .md; y loadPrompt lee la copia, no el archivo', () => {
  assert.deepEqual([...PROMPT_NAMES].sort(), Object.keys(PROMPTS).sort());
  for (const name of PROMPT_NAMES as Array<keyof typeof PROMPTS>) {
    const md = readFileSync(new URL(`../src/outreach/prompts/${name}.md`, import.meta.url), 'utf8');
    assert.equal(PROMPTS[name], md, name);
    assert.equal(loadPrompt(name), md, name);
    assert.ok(md.length > 100, `${name}.md no está vacío`);
  }
});

test('generate.ts ya no lee archivos por ruta (el bundle de Next congelaría la ruta de la máquina de build)', () => {
  const src = readFileSync(new URL('../src/outreach/generate.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'node:fs'/);
  assert.doesNotMatch(src, /readFileSync\(/);
});
