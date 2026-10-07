/**
 * Pruebas de scripts/verificar.sh (CIM-12): qué comando corre según los
 * argumentos y cuándo un turno se da por libre. Cada prueba usa su propia
 * carpeta de turnos (MC_VERIFICAR_TURNOS_DIR), nunca la de la máquina.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as dormir } from 'node:timers/promises';
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

/**
 * La hora de arranque de `pid`, por omisión tal como la escribe
 * verificar.sh (LC_ALL=C). Con otro `idioma`, como la escribía antes una
 * Terminal en ese idioma: «lun 5 oct …» con es_ES.UTF-8.
 */
const arranqueDe = (pid, idioma = 'C') =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: idioma } })
    .replace(/\s+/g, ' ')
    .trim();

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

/**
 * Con los dos turnos ocupados, lanza verificar.sh con `espera` (undefined:
 * sin MC_VERIFICAR_ESPERA_MAX), lo corta en cuanto avisa que espera y
 * devuelve ese aviso: dice el techo.
 */
async function avisoDeEspera(t, espera) {
  const dir = carpeta(t);
  const hora = arranqueDe(process.pid);
  ocupar(dir, 1, process.pid, hora);
  ocupar(dir, 2, process.pid, hora);
  const env = { ...process.env, MC_VERIFICAR_TURNOS_DIR: dir };
  if (espera === undefined) delete env.MC_VERIFICAR_ESPERA_MAX;
  else env.MC_VERIFICAR_ESPERA_MAX = espera;
  const hijo = spawn('bash', [SCRIPT, 'true'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  await new Promise((resolve) => {
    hijo.stderr.on('data', (d) => {
      err += d;
      if (/espero turno \(.*\)/.test(err)) resolve();
    });
    hijo.on('close', resolve);
  });
  hijo.kill('SIGTERM');
  return err;
}

test('sin MC_VERIFICAR_ESPERA_MAX, la espera llega a 1800 s: con dos turnos y cuatro piezas a la vez, 600 se quedaba corto', async (t) => {
  assert.match(await avisoDeEspera(t, undefined), /espero turno \(como mucho 1800 s\)/);
});

test('con MC_VERIFICAR_ESPERA_MAX=0 (como lo lanza el estrés) el aviso dice «sin techo», no «como mucho 0 s»', async (t) => {
  const err = await avisoDeEspera(t, '0');
  assert.match(err, /espero turno \(sin techo\)/);
  assert.doesNotMatch(err, /como mucho 0 s/);
});

test('un turno con la hora escrita en español (versión anterior, Terminal con LANG=es_ES) no se libera: sale con 75', async (t) => {
  const dir = carpeta(t);
  // Así quedaba la hora cuando verificar.sh la leía con el idioma de quien
  // lo lanzaba. En una máquina sin es_ES (el CI) sale en C: la prueba
  // sigue valiendo, es la de un turno vivo normal.
  const hora = arranqueDe(process.pid, 'es_ES.UTF-8');
  ocupar(dir, 1, process.pid, hora);
  ocupar(dir, 2, process.pid, hora);
  const r = await correr(['true'], { MC_VERIFICAR_TURNOS_DIR: dir, MC_VERIFICAR_ESPERA_MAX: '1', LC_ALL: 'C', LANG: '' });
  assert.equal(r.codigo, 75, r.err);
  assert.doesNotMatch(r.err, /lo libero/, 'el dueño vive: su turno no se toca');
  assert.deepEqual(readdirSync(dir).sort(), ['turno-1', 'turno-2']);
  assert.equal(readFileSync(join(dir, 'turno-1', 'duenio'), 'utf8'), `${process.pid}@${HOST}\n${hora}\n`);
});

test('un verificar lanzado en español y otro en C (un agente) respetan sus turnos: el tope de dos no se rompe', async (t) => {
  const dir = carpeta(t);
  ocupar(dir, 2, process.pid, arranqueDe(process.pid));
  // El dueño del turno 1 es un verificar de verdad, desde una Terminal en
  // español, que tiene el turno mientras su comando corre.
  const persona = spawn('bash', [SCRIPT, 'sleep', '60'], {
    env: { ...process.env, MC_VERIFICAR_TURNOS_DIR: dir, LC_ALL: 'es_ES.UTF-8', LANG: 'es_ES.UTF-8' },
    stdio: 'ignore',
    // Su propio grupo, para cortarlo con su `sleep`: bash no atiende el
    // SIGTERM hasta que termina el comando que espera.
    detached: true,
  });
  t.after(async () => {
    if (persona.exitCode !== null || persona.signalCode !== null) return;
    const cerrado = new Promise((r) => persona.on('close', r));
    try {
      process.kill(-persona.pid, 'SIGTERM');
    } catch {
      // Ya no estaba.
    }
    await cerrado;
  });
  const duenio = join(dir, 'turno-1', 'duenio');
  for (let i = 0; i < 100 && !(existsSync(duenio) && readFileSync(duenio, 'utf8').split('\n').length >= 3); i++) await dormir(50);
  const [linea, hora] = readFileSync(duenio, 'utf8').split('\n');
  assert.equal(linea, `${persona.pid}@${HOST}`);
  assert.match(hora, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /, 'la hora queda escrita en C aunque quien lo lanza esté en español');
  const r = await correr(['true'], { MC_VERIFICAR_TURNOS_DIR: dir, MC_VERIFICAR_ESPERA_MAX: '2', LC_ALL: 'C', LANG: '' });
  assert.equal(r.codigo, 75, r.err);
  assert.doesNotMatch(r.err, /lo libero/, 'el verificar en español sigue vivo: su turno no se toca');
  assert.equal(readFileSync(duenio, 'utf8').split('\n')[0], `${persona.pid}@${HOST}`);
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
