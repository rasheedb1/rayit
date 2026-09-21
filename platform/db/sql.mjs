#!/usr/bin/env node
/**
 * Consola SQL contra Supabase. Existe porque en esta máquina no hay
 * psql instalado, y porque así nadie necesita copiar y pegar una
 * cadena de conexión con contraseña a mano.
 *
 *   node db/sql.mjs "select count(*) from workspace"
 *   node db/sql.mjs --admin "alter table x add column y int"
 *   node db/sql.mjs -f archivo.sql
 *
 * Por defecto entra como mc_app, que solo lee y escribe filas. Con
 * --admin entra como mc_migrator, que además puede alterar el esquema.
 * El valor por defecto es el que menos daño puede hacer, a propósito.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(HERE, '..');

function cargarEnv() {
  const ruta = join(RAIZ, '.env.local');
  if (!existsSync(ruta)) {
    console.error(
      '\n  No hay credenciales descifradas.\n' +
      '  Corre:  make db.unlock\n' +
      '  (si no tienes la frase de paso, pídesela a Rasheed)\n'
    );
    process.exit(1);
  }
  const env = {};
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const m = linea.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Imprime filas como tabla, recortando lo que no cabe en la terminal. */
function tabla(filas) {
  if (!filas?.length) return console.log('  (sin filas)\n');
  const cols = Object.keys(filas[0]);
  const ancho = Object.fromEntries(cols.map((c) => [
    c, Math.min(40, Math.max(c.length, ...filas.map((f) => String(f[c] ?? '').length))),
  ]));
  const fila = (vals) => '  ' + cols.map((c, i) => String(vals[i] ?? '').slice(0, ancho[c]).padEnd(ancho[c])).join('  ');
  console.log('\n' + fila(cols));
  console.log('  ' + cols.map((c) => '─'.repeat(ancho[c])).join('  '));
  for (const f of filas) console.log(fila(cols.map((c) => f[c])));
  console.log(`\n  ${filas.length} fila(s)\n`);
}

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const iArchivo = args.indexOf('-f');
const sql = iArchivo >= 0
  ? readFileSync(args[iArchivo + 1], 'utf8')
  : args.filter((a) => a !== '--admin').join(' ');

if (!sql.trim()) {
  console.error('Uso: node db/sql.mjs [--admin] "SELECT ..." | -f archivo.sql');
  process.exit(1);
}

const env = cargarEnv();
const url = admin ? env.DATABASE_URL_DIRECT : env.DATABASE_URL;
const pg = await import('pg');
const cliente = new pg.default.Client({
  connectionString: url,
  ssl: { ca: readFileSync(join(HERE, 'certs', 'supabase-root-2021.crt'), 'utf8'), rejectUnauthorized: true },
});

await cliente.connect();
const quien = await cliente.query('select current_user');
console.log(`\n  Conectado como ${quien.rows[0].current_user}${admin ? '  (puede alterar el esquema)' : '  (solo filas)'}`);
try {
  const r = await cliente.query(sql);
  Array.isArray(r) ? r.forEach((x) => tabla(x.rows)) : tabla(r.rows);
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
