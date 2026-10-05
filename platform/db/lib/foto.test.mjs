/**
 * La foto compartida de db/lib/foto.mjs entre procesos de verdad (CIM-12).
 *
 *   node --test db/lib/foto.test.mjs        (lo corre `pnpm test` de platform)
 *
 * Cada caso lanza procesos hijos (la caché en memoria es por proceso) con
 * su propia carpeta de fotos (MC_PGLITE_FOTO_DIR) y una carpeta de
 * migraciones de juguete: no toca la caché de verdad ni db/migrations.
 * Cada hijo apunta en CONTADOR una línea por cada vez que construye.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLATFORM = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FOTO = pathToFileURL(join(PLATFORM, 'db', 'lib', 'foto.mjs')).href;

/** El hijo: pide la foto, la abre y dice cuánto tardó y qué tabla trae. */
const HIJO = `
import { PGlite } from '@electric-sql/pglite';
import { appendFileSync } from 'node:fs';
const { fotoMigrada } = await import(${JSON.stringify(FOTO)});
const t0 = Date.now();
const foto = await fotoMigrada({
  PGlite,
  extensions: {},
  motor: 'prueba',
  clave: 'prueba',
  dir: process.env.MIGRACIONES,
  preparar: async (p) => {
    appendFileSync(process.env.CONTADOR, process.pid + '\\n');
    if (process.env.LENTO) await new Promise((r) => setTimeout(r, Number(process.env.LENTO)));
    const sql = (await import('node:fs')).readFileSync(process.env.MIGRACIONES + '/0001_t.sql', 'utf8');
    await p.exec(sql);
  },
});
const db = await PGlite.create({ loadDataDir: foto });
const { rows } = await db.query("SELECT string_agg(tablename, ',' ORDER BY tablename) AS t FROM pg_tables WHERE schemaname = 'public'");
await db.close();
console.log(JSON.stringify({ ms: Date.now() - t0, tablas: rows[0].t }));
`;

function escenario() {
  const raiz = mkdtempSync(join(tmpdir(), 'mc-foto-prueba-'));
  const fotos = join(raiz, 'fotos');
  const migraciones = join(raiz, 'migraciones');
  mkdirSync(migraciones);
  writeFileSync(join(migraciones, '0001_t.sql'), 'CREATE TABLE uno (x int);');
  const contador = join(raiz, 'contador');
  writeFileSync(contador, '');
  return {
    raiz,
    fotos,
    migraciones,
    construcciones: () => readFileSync(contador, 'utf8').split('\n').filter(Boolean).length,
    tars: () => (existsSync(fotos) ? readdirSync(fotos).filter((f) => f.endsWith('.tar')) : []),
    candados: () => (existsSync(fotos) ? readdirSync(fotos).filter((f) => f.endsWith('.candado')) : []),
    env: (extra = {}) => ({ ...process.env, MC_PGLITE_FOTO_DIR: fotos, MIGRACIONES: migraciones, CONTADOR: contador, ...extra }),
    limpiar: () => rmSync(raiz, { recursive: true, force: true }),
  };
}

/** Lanza un hijo; `fin` resuelve con { codigo, salida, errores, json }. */
function hijo(env) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', HIJO], { cwd: PLATFORM, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  let errores = '';
  p.stdout.on('data', (d) => (salida += d));
  p.stderr.on('data', (d) => (errores += d));
  const fin = new Promise((resolve) =>
    p.on('close', (codigo) => {
      let json = null;
      try {
        json = JSON.parse(salida.trim().split('\n').at(-1));
      } catch {}
      resolve({ codigo, salida, errores, json });
    }),
  );
  return { proceso: p, fin, errores: () => errores };
}

async function hasta(cond, ms, etiqueta) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`no pasó a tiempo: ${etiqueta}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('dos procesos a la vez: uno construye, el otro espera y carga la misma foto', async () => {
  const e = escenario();
  try {
    const [a, b] = [hijo(e.env({ LENTO: '1500' })), hijo(e.env({ LENTO: '1500' }))];
    const [ra, rb] = await Promise.all([a.fin, b.fin]);
    assert.equal(ra.codigo, 0, ra.errores);
    assert.equal(rb.codigo, 0, rb.errores);
    assert.equal(e.construcciones(), 1, 'se construyó una sola vez');
    assert.deepEqual([ra.json.tablas, rb.json.tablas], ['uno', 'uno']);
    assert.equal(e.tars().length, 1);
    assert.deepEqual(e.candados(), [], 'el candado se soltó');
  } finally {
    e.limpiar();
  }
});

test('candado de un proceso muerto: avisa mientras espera y lo toma en cuanto el pid ya no existe', async () => {
  const e = escenario();
  try {
    // A toma el candado y se queda construyendo un minuto.
    const a = hijo(e.env({ LENTO: '60000' }));
    await hasta(() => e.candados().length === 1, 30_000, 'A toma el candado');
    const candado = join(e.fotos, e.candados()[0]);
    assert.equal(readFileSync(candado, 'utf8').trim(), `${a.proceso.pid}@${hostname()}`, 'el candado lleva pid@host');

    // B espera a A (vivo) y lo dice por stderr pasados 10 s, con el pid y la ruta.
    const b = hijo(e.env());
    await hasta(() => b.errores().includes('esperando la foto'), 20_000, 'B avisa que espera');
    assert.match(b.errores(), new RegExp(`el pid ${a.proceso.pid}`));
    assert.ok(b.errores().includes(candado), 'el aviso lleva la ruta del candado');
    assert.equal(e.tars().length, 0, 'B no construyó mientras A vivía');

    // kill -9 a A: el finally no corre y el candado se queda. B lo toma solo.
    const t0 = Date.now();
    a.proceso.kill('SIGKILL');
    const rb = await b.fin;
    assert.equal(rb.codigo, 0, rb.errores);
    assert.equal(rb.json.tablas, 'uno');
    assert.ok(Date.now() - t0 < 20_000, `B tardó ${Date.now() - t0} ms en tomar el candado del muerto`);
    assert.match(rb.errores, /que ya no está; lo tomo/);
    assert.equal(e.construcciones(), 2, 'A empezó y murió; B construyó');
    assert.deepEqual(e.candados(), []);
  } finally {
    e.limpiar();
  }
});

test('una migración cambiada da otra foto, y la vieja no se carga', async () => {
  const e = escenario();
  try {
    const r1 = await hijo(e.env()).fin;
    assert.equal(r1.json.tablas, 'uno', r1.errores);
    const [primera] = e.tars();
    writeFileSync(join(e.migraciones, '0001_t.sql'), 'CREATE TABLE dos (x int);');
    const r2 = await hijo(e.env()).fin;
    assert.equal(r2.json.tablas, 'dos', r2.errores);
    assert.equal(e.construcciones(), 2);
    assert.equal(e.tars().length, 2, 'la vieja se queda una hora por si otro proceso la usa');
    assert.ok(e.tars().some((t) => t !== primera));
    // Y la misma migración otra vez carga, sin construir.
    const r3 = await hijo(e.env()).fin;
    assert.equal(r3.json.tablas, 'dos', r3.errores);
    assert.equal(e.construcciones(), 2);
  } finally {
    e.limpiar();
  }
});

test('MC_PGLITE_FOTO=0 construye en memoria cada vez y no escribe nada', async () => {
  const e = escenario();
  try {
    for (let i = 0; i < 2; i++) {
      const r = await hijo(e.env({ MC_PGLITE_FOTO: '0' })).fin;
      assert.equal(r.json.tablas, 'uno', r.errores);
    }
    assert.equal(e.construcciones(), 2);
    assert.equal(existsSync(e.fotos), false, 'ni siquiera crea la carpeta');
  } finally {
    e.limpiar();
  }
});

test('dentro de node:test, esperar el candado de otro proceso no deja el bucle vacío ni cancela la prueba', async () => {
  // Lo que pidió la revisión de CIM-12 (r3): la espera del candado de OTRO
  // proceso, dentro del propio runner de node:test (las demás pruebas de
  // este archivo esperan en procesos hijos). Sin hijo a propósito: un
  // ChildProcess vivo es un handle que mantendría vivo el bucle por su
  // cuenta. El candado es de un pid vivo que no es nuestro (el 1, launchd
  // o init: kill(1, 0) da EPERM, «vive y es de otro usuario») y se suelta
  // con un temporizador SIN ref.
  //
  // Lo que esta prueba NO puede ver, medido el 5-oct: con Node 24 y 25 el
  // runner de node:test mantiene vivo el bucle él solo mientras quede una
  // prueba pendiente (un setInterval en su beforeExit), así que una espera
  // sin handles aquí dentro no se cancela: cuelga hasta --test-timeout. La
  // cancelación con «Promise resolution is still pending but the event
  // loop has already resolved» en esas versiones viene de un SIGTERM o un
  // SIGINT al proceso (docs/propuestas/CIM-12.md §Mecanismo). Donde el
  // setTimeout con ref de foto.mjs sí decide es en un proceso suelto (el
  // `node -e` de los hijos de arriba): con un .unref() ahí, «dos procesos a
  // la vez» falla porque el hijo que espera sale con el await sin resolver.
  const e = escenario();
  try {
    const { fotoMigrada } = await import(FOTO);
    const { PGlite } = await import('@electric-sql/pglite');
    const args = {
      PGlite,
      extensions: {},
      motor: 'prueba',
      clave: 'prueba-en-proceso',
      dir: e.migraciones,
      carpeta: e.fotos,
      preparar: async (p) => {
        await p.exec(readFileSync(join(e.migraciones, '0001_t.sql'), 'utf8'));
      },
    };
    // El nombre del candado sale de la huella: se construye una vez en
    // otra carpeta (la sonda) y se copia el nombre.
    const sondaDir = join(e.raiz, 'sonda');
    await fotoMigrada({ ...args, carpeta: sondaDir });
    const [tar] = readdirSync(sondaDir).filter((f) => f.endsWith('.tar'));
    mkdirSync(e.fotos, { recursive: true });
    const candado = join(e.fotos, `${tar}.candado`);
    writeFileSync(candado, `1@${hostname()}`);
    setTimeout(() => rmSync(candado, { force: true }), 1_500).unref();

    const t0 = performance.now();
    const foto = await fotoMigrada(args);
    const ms = performance.now() - t0;
    assert.ok(ms >= 1_400, `esperó al candado ajeno (${Math.round(ms)} ms)`);
    const db = await PGlite.create({ loadDataDir: foto });
    try {
      const { rows } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      assert.deepEqual(rows.map((r) => r.tablename), ['uno']);
    } finally {
      await db.close();
    }
    assert.deepEqual(e.candados(), [], 'soltó su candado');
  } finally {
    e.limpiar();
  }
});
