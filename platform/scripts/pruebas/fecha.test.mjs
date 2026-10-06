/**
 * Pruebas de scripts/pruebas/fecha.mjs (CIM-12): el Date que comparten
 * reloj.mjs (el ancla) y maquina.mjs (la máquina N días adelante). Cada
 * caso corre en un proceso aparte, para no mover el Date de este.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIA = 86_400_000;

/** Corre `codigo` con `--import modulo` y el entorno dado; devuelve lo que imprime como JSON y su stderr. */
function correr(modulo, env, codigo) {
  const limpio = { ...process.env };
  for (const k of Object.keys(limpio)) if (k.startsWith('MC_RELOJ') || k === 'TEST_DATABASE_URL') delete limpio[k];
  const salida = execFileSync(process.execPath, ['--import', join(AQUI, modulo), '--input-type=module', '-e', codigo], {
    env: { ...limpio, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(salida);
}

const SONDA = `
  class Mia extends Date {}
  const ahora = Date.now();
  console.log(JSON.stringify({
    ahora,
    sinArgs: new Date().getTime(),
    texto: typeof Date(),
    textoAhora: Date.parse(Date()),
    conArgs: new Date(0).getTime(),
    utc: Date.UTC(2026, 0, 1),
    parse: Date.parse('2026-01-01T00:00:00Z'),
    instancia: new Date() instanceof Date,
    subclase: new Mia() instanceof Mia && new Mia() instanceof Date,
    real: performance.timeOrigin + performance.now(),
  }));`;

test('maquina.mjs mueve el ahora N días y deja lo demás como el Date de siempre', () => {
  const r = correr('maquina.mjs', { MC_RELOJ_DIAS: '9' }, SONDA);
  assert.ok(Math.abs(r.ahora - r.real - 9 * DIA) < 5_000, `+9 días: ${r.ahora - r.real} ms`);
  assert.ok(Math.abs(r.sinArgs - r.ahora) < 5_000, 'new Date() sin argumentos también');
  assert.equal(r.texto, 'string', 'Date() sin new devuelve texto');
  assert.ok(Math.abs(r.textoAhora - r.ahora) < 5_000, 'y es el ahora movido');
  assert.equal(r.conArgs, 0, 'con argumentos, la fecha pedida');
  assert.equal(r.utc, 1_767_225_600_000);
  assert.equal(r.parse, 1_767_225_600_000);
  assert.equal(r.instancia, true);
  assert.equal(r.subclase, true, 'class X extends Date sigue creando X');
});

test('reloj.mjs ancla el ahora al 5-oct-2026 15:00 UTC (más MC_RELOJ_ANCLA_DIAS) y el tiempo corre desde ahí', () => {
  const r = correr('reloj.mjs', { MC_RELOJ_ANCLA_DIAS: '2' }, SONDA);
  const ancla = Date.parse('2026-10-05T15:00:00Z') + 2 * DIA;
  assert.ok(r.ahora >= ancla && r.ahora - ancla < 5_000, `${new Date(r.ahora).toISOString()}`);
  assert.equal(r.conArgs, 0);
  assert.equal(r.instancia, true);
  assert.equal(r.subclase, true);
});

test('las dos simulaciones usan el mismo Date: maquina.mjs y reloj.mjs juntos, manda el ancla', () => {
  const env = { MC_RELOJ_DIAS: '30', NODE_OPTIONS: `--import ${join(AQUI, 'maquina.mjs')}` };
  const r = correr('reloj.mjs', env, SONDA);
  const ancla = Date.parse('2026-10-05T15:00:00Z');
  assert.ok(r.ahora >= ancla && r.ahora - ancla < 5_000, 'la máquina a +30 no mueve el día de las pruebas');
  assert.equal(r.subclase, true);
});

test('cada proceso dice su reloj con su tarea: reloj[paquete#script]', () => {
  // Por stderr, para no ensuciar la salida de quien lo carga.
  const err = execFileSync('bash', ['-c', `"${process.execPath}" --import "${join(AQUI, 'maquina.mjs')}" -e "" 2>&1`], {
    env: { ...process.env, MC_RELOJ_DIAS: '2', npm_package_name: '@mc/db', npm_lifecycle_event: 'test' },
    encoding: 'utf8',
  });
  assert.match(err, /^reloj\[@mc\/db#test\]: la máquina a \+2 días \(pid \d+\)$/m);
});
