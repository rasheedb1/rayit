/**
 * Pruebas de scripts/verificar.sh (CIM-12): qué comando corre según los
 * argumentos y cuándo un turno se da por libre. Cada prueba usa su propia
 * carpeta de turnos (MC_VERIFICAR_TURNOS_DIR), nunca la de la máquina.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'verificar.sh');
const HOST = hostname();

/** Corre verificar.sh con `args` y `env` de más; devuelve código, stdout y stderr. */
function correr(args, env = {}) {
  return new Promise((resolve) => {
    const hijo = spawn('bash', [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    hijo.stdout.on('data', (d) => (out += d));
    hijo.stderr.on('data', (d) => (err += d));
    hijo.on('close', (codigo) => resolve({ codigo, out, err }));
  });
}

/** Una carpeta de turnos nueva, que se borra al terminar la prueba. */
function carpeta(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-turnos-prueba-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** La hora de arranque de `pid` tal como la escribe verificar.sh. */
const arranqueDe = (pid) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();

/** Ocupa el turno `k` de `dir` a nombre de `pid`, con la hora `hora`. */
function ocupar(dir, k, pid, hora) {
  const t = join(dir, `turno-${k}`);
  mkdirSync(t);
  writeFileSync(join(t, 'duenio'), `${pid}@${HOST}\n${hora}\n`);
  writeFileSync(join(t, 'clon'), '/otro/clon\n');
  return t;
}

const TURBO = 'pnpm exec turbo run typecheck lint test --force --concurrency=2 --continue';

test('sin argumentos corre turbo; con banderas, las añade a turbo; con un comando, corre ese', async () => {
  const seco = { MC_VERIFICAR_SECO: '1' };
  assert.equal((await correr([], seco)).out.trim(), TURBO);
  assert.equal((await correr(['--filter=@mc/db'], seco)).out.trim(), `${TURBO} --filter=@mc/db`);
  assert.equal((await correr(['--filter', '@mc/core', '--continue'], seco)).out.trim(), `${TURBO} --filter @mc/core --continue`);
  assert.equal((await correr(['pnpm', 'exec', 'turbo', 'run', 'test'], seco)).out.trim(), 'pnpm exec turbo run test');
});

test('un comando corre con turno y lo suelta al terminar, con el código del comando', async (t) => {
  const dir = carpeta(t);
  const r = await correr(['bash', '-c', 'exit 3'], { MC_VERIFICAR_TURNOS_DIR: dir });
  assert.equal(r.codigo, 3);
  assert.deepEqual(readdirSync(dir), [], 'el turno queda libre');
});

test('un turno de un pid muerto se libera', async (t) => {
  const dir = carpeta(t);
  // Un pid que ya no existe: el de un proceso que acaba de terminar.
  const muerto = spawn('true');
  await new Promise((r) => muerto.on('close', r));
  ocupar(dir, 1, muerto.pid, 'Mon Jan 1 00:00:00 2024');
  ocupar(dir, 2, process.pid, arranqueDe(process.pid));
  const r = await correr(['true'], { MC_VERIFICAR_TURNOS_DIR: dir, MC_VERIFICAR_ESPERA_MAX: '5' });
  assert.equal(r.codigo, 0, r.err);
  assert.match(r.err, new RegExp(`el turno 1 era de ${muerto.pid}@.*que ya no está; lo libero`));
  assert.doesNotMatch(r.err, /el turno 2/, 'el vivo no se toca');
});

test('un turno de un pid reciclado por otro proceso (otra hora de arranque) se libera', async (t) => {
  const dir = carpeta(t);
  // El turno 1 es de un dueño vivo de verdad; el 2, de este mismo pid pero
  // con otra hora de arranque: el verificar que lo tenía murió y el
  // sistema le dio su pid a otro proceso.
  ocupar(dir, 1, process.pid, arranqueDe(process.pid));
  ocupar(dir, 2, process.pid, 'Mon Jan 1 00:00:00 2024');
  const r = await correr(['true'], { MC_VERIFICAR_TURNOS_DIR: dir, MC_VERIFICAR_ESPERA_MAX: '5' });
  assert.equal(r.codigo, 0, r.err);
  assert.match(r.err, /el turno 2 era de \d+@.*que ya no está; lo libero/);
  assert.doesNotMatch(r.err, /el turno 1/, 'el vivo no se toca');
});

test('un turno de más de dos horas se libera aunque su dueño viva', async (t) => {
  const dir = carpeta(t);
  const viejo = ocupar(dir, 1, process.pid, arranqueDe(process.pid));
  ocupar(dir, 2, process.pid, arranqueDe(process.pid));
  // Una fecha fija y no Date.now() - 3 h: con scripts/pruebas/reloj.mjs
  // (estres-verificar.sh --dias) Date va adelantado y el turno saldría del futuro.
  utimesSync(viejo, 1_600_000_000, 1_600_000_000);
  const r = await correr(['true'], { MC_VERIFICAR_TURNOS_DIR: dir, MC_VERIFICAR_ESPERA_MAX: '5' });
  assert.equal(r.codigo, 0, r.err);
  assert.match(r.err, /el turno 1 era de .*lo libero/);
  assert.doesNotMatch(r.err, /el turno 2/, 'el turno vivo y reciente no se toca');
});

test('sin turno en MC_VERIFICAR_ESPERA_MAX segundos sale con 75 y dice quién los tiene, sin correr nada', async (t) => {
  const dir = carpeta(t);
  const hora = arranqueDe(process.pid);
  ocupar(dir, 1, process.pid, hora);
  ocupar(dir, 2, process.pid, hora);
  const marca = join(dir, 'corrio');
  const r = await correr(['touch', marca], { MC_VERIFICAR_TURNOS_DIR: dir, MC_VERIFICAR_ESPERA_MAX: '1' });
  assert.equal(r.codigo, 75);
  assert.match(r.err, /no hubo turno en 1 s; estos lo tienen:/);
  assert.match(r.err, new RegExp(`${process.pid}@.* en /otro/clon`));
  assert.match(r.err, /NO es un rojo.*Vuelve a lanzarlo/, 'quien lo lanza sabe que no es un fallo de las pruebas');
  assert.ok(!readdirSync(dir).includes('corrio'), 'no corrió el comando');
  assert.deepEqual(readdirSync(dir).sort(), ['turno-1', 'turno-2'], 'los turnos ajenos siguen ahí');
});

test('sin MC_VERIFICAR_ESPERA_MAX, la espera llega a 1800 s: con dos turnos y cuatro piezas a la vez, 600 se quedaba corto', async (t) => {
  const dir = carpeta(t);
  const hora = arranqueDe(process.pid);
  ocupar(dir, 1, process.pid, hora);
  ocupar(dir, 2, process.pid, hora);
  const env = { ...process.env, MC_VERIFICAR_TURNOS_DIR: dir };
  delete env.MC_VERIFICAR_ESPERA_MAX;
  // Basta con ver el aviso de la espera, que dice el techo, y cortarlo.
  const hijo = spawn('bash', [SCRIPT, 'true'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  await new Promise((resolve) => {
    hijo.stderr.on('data', (d) => {
      err += d;
      if (/como mucho \d+ s/.test(err)) resolve();
    });
    hijo.on('close', resolve);
  });
  hijo.kill('SIGTERM');
  assert.match(err, /espero turno \(como mucho 1800 s\)/);
});

test('los --test-timeout de @mc/db y del worker son PRUEBA_SCRIPT_TIMEOUT_MS de @mc/db/test/tiempos.ts', () => {
  const raiz = join(dirname(SCRIPT), '..');
  const tiempos = readFileSync(join(raiz, 'packages/db/test/tiempos.ts'), 'utf8');
  const m = /PRUEBA_SCRIPT_TIMEOUT_MS = ([\d_]+);/.exec(tiempos);
  assert.ok(m, 'la constante existe');
  const ms = Number(m[1].replaceAll('_', ''));
  for (const paquete of ['packages/db', 'apps/worker']) {
    const test = JSON.parse(readFileSync(join(raiz, paquete, 'package.json'), 'utf8')).scripts.test;
    assert.match(test, new RegExp(`--test-timeout=${ms}(\\s|$)`), `${paquete}: ${test}`);
  }
});
