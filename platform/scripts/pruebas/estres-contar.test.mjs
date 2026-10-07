/**
 * Pruebas de scripts/pruebas/estres-contar.sh (CIM-12): cómo cuenta
 * estres-verificar.sh un registro de `pnpm verificar`, también cuando
 * turbo mezcla la salida de dos tareas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CONTAR = join(AQUI, 'estres-contar.sh');
const TODAS = '@mc/connectors#test @mc/core#test @mc/db#test @mc/web#test @mc/worker#test on-cue-platform#test';

/** Escribe `texto` en un registro temporal y corre `funcion …args` de estres-contar.sh sobre él. */
function sobre(t, texto, funcion, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-estres-contar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'corrida-01.log');
  writeFileSync(log, texto);
  return execFileSync('bash', ['-c', `source "$1"; shift; "$@"`, 'bash', CONTAR, funcion, log, ...args], { encoding: 'utf8' }).trim();
}

/** Un registro de una corrida verde con la máquina a +9: cada tarea dice su reloj. */
const VERDE_MAQUINA = [
  'reloj[on-cue-platform#verificar]: la máquina a +9 días (pid 1)',
  '//:test: reloj[on-cue-platform#test]: la máquina a +9 días (pid 2)',
  '@mc/core:test: reloj[@mc/core#test]: la máquina a +9 días (pid 3)',
  '@mc/connectors:test: reloj[@mc/connectors#test]: la máquina a +9 días (pid 4)',
  '@mc/db:test: reloj[@mc/db#test]: la máquina a +9 días (pid 5)',
  '@mc/worker:test: reloj[@mc/worker#test]: la máquina a +9 días (pid 6)',
  '@mc/web:test: reloj[@mc/web#test]: la máquina a +9 días (pid 7)',
  '@mc/db:test: ℹ pass 1457',
  '@mc/db:test: ℹ fail 0',
  '@mc/db:test: ℹ cancelled 0',
  '@mc/web:test:       Tests  612 passed (612)',
  '',
].join('\n');

test('una corrida verde: todo en cero y ninguna tarea sin su reloj', (t) => {
  assert.equal(sobre(t, VERDE_MAQUINA, 'contar'), '0 0 - 0 0 0 0');
  assert.equal(sobre(t, VERDE_MAQUINA, 'sin_reloj', '9', '0', '0', TODAS), '0');
});

test('los prefijos mezclados de turbo no cuentan como tareas sin reloj (r3: la corrida salía roja estando verde)', (t) => {
  // Lo que deja turbo cuando dos tareas escriben a la vez (visto en un pnpm verificar de la revisión).
  const mezclado = [
    '@mc/db:test:@mc/worker:test: reloj[@mc/worker#test]: anclado en 2026-10-14T15:00:00.000Z (pid 6)',
    'reloj[@mc/db#test]: anclado en 2026-10-14T15:00:00.000Z (ancla +9 días) (pid 5)',
    '@mc/web:t@mc/web:test: ℹ algo',
    '@mc@mc/worker:test: reloj[@mc/web#test]: anclado en 2026-10-14T15:00:00.000Z (pid 7)',
    '@mc/db:test:@mc/worker:test: ℹ fail 0',
    '',
  ].join('\n');
  assert.equal(sobre(t, mezclado, 'sin_reloj', '0', '9', '0', TODAS), '0', 'con solo el ancla, las tres tareas que la cargan lo dijeron');
  assert.equal(sobre(t, mezclado, 'contar'), '0 0 - 0 0 0 0');
});

test('una tarea que no dijo su reloj sí cuenta, aunque su prefijo aparezca', (t) => {
  const sinWeb = VERDE_MAQUINA.replace('@mc/web:test: reloj[@mc/web#test]: la máquina a +9 días (pid 7)\n', '');
  assert.equal(sobre(t, sinWeb, 'sin_reloj', '9', '0', '0', TODAS), '1');
  // El reloj del pnpm de fuera (on-cue-platform#verificar) no vale por el de la tarea de la raíz.
  const sinRaiz = VERDE_MAQUINA.replace('//:test: reloj[on-cue-platform#test]: la máquina a +9 días (pid 2)\n', '');
  assert.equal(sobre(t, sinRaiz, 'sin_reloj', '9', '0', '0', TODAS), '1');
});

test('sin nada movido no se mira el reloj («-»), y sin ancla tampoco cuando solo se movió el ancla', (t) => {
  assert.equal(sobre(t, VERDE_MAQUINA, 'sin_reloj', '0', '0', '0', TODAS), '-');
  assert.equal(sobre(t, VERDE_MAQUINA, 'sin_reloj', '0', '3', '1', TODAS), '-');
});

test('con --filtro, solo cuentan las tareas que corrieron', (t) => {
  const soloDb = '@mc/db:test: reloj[@mc/db#test]: anclado en 2026-10-08T15:00:00.000Z (ancla +3 días) (pid 5)\n';
  assert.equal(sobre(t, soloDb, 'sin_reloj', '0', '3', '0', '@mc/db#test'), '0');
  assert.equal(sobre(t, 'nada\n', 'sin_reloj', '0', '3', '0', '@mc/db#test'), '1');
});

test('suma los fallos de node:test y de vitest, los archivos en FAIL, las canceladas y las tareas en rojo', (t) => {
  const rojo = [
    '@mc/db:test: ℹ fail 4',
    '@mc/worker:test: ℹ fail 1',
    '@mc/worker:test: ℹ cancelled 2',
    '@mc/web:test:  Test Files  1 failed | 80 passed (81)',
    '@mc/web:test:       Tests  3 failed | 600 passed | 9 skipped (612)',
    '@mc/web:test:      Errors  1 error',
    ' Failed:    @mc/db#test, @mc/worker#test',
    'verificar: turno tomado tras 42 s de espera.',
    '',
  ].join('\n');
  assert.equal(sobre(t, rojo, 'contar'), '8 1 9 2 1 2 42');
});
