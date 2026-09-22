#!/usr/bin/env node
/**
 * Verificación de los seeds en Postgres embebido (sin tocar Supabase).
 *
 *   node db/seed/verify/run.mjs            todos los verify/NNNN.sql
 *   node db/seed/verify/run.mjs 0002       solo ese
 *
 * Qué hace, en orden:
 *   1. Levanta PGlite y aplica las migraciones como un rol NO superusuario
 *      (mc_migrator_test), igual que en Supabase. Importa: las tablas
 *      tienen FORCE ROW LEVEL SECURITY y las vistas corren con los
 *      privilegios de su dueño; con el superusuario de PGlite, RLS se
 *      saltaría y la verificación mentiría.
 *   2. Corre TODOS los seeds (db/seed/*.sql) DOS veces y cuenta las filas
 *      por tabla después de cada pasada: tienen que ser idénticas. Si
 *      no, sale con código 1.
 *   3. Ejecuta cada verify/NNNN.sql pedido y muestra sus resultados. Una
 *      consulta que devuelva una columna `ok` con algún false hace
 *      fallar la verificación: así el archivo es una prueba, no una
 *      impresión.
 *   4. Tercera pasada con el reloj adelantado un día: es lo que pasa
 *      cuando la segunda persona corre `make db.migrate` (que lleva
 *      --seed) al día siguiente. Se reemplazan CURRENT_DATE y now() en
 *      el texto de los seeds por su valor de mañana y se vuelven a
 *      correr; después se exige que ningún conteo haya cambiado, salvo
 *      post_metric_snapshot, que solo puede crecer con las lecturas que
 *      la curva de cada video alcanzó en ese día, y que sigan valiendo
 *      los invariantes de las lecturas: ningún par (post, edad, fuente)
 *      repetido, ninguna edad incoherente con published_at y ninguna
 *      curva que baje.
 *
 * Es deliberadamente independiente de db/migrate.mjs (que corre como
 * superusuario y no ejecuta los seeds dos veces). No necesita red.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', '..');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const SEED_DIR = join(DB_DIR, 'seed');

/** Tablas que sí pueden crecer en la pasada con el reloj adelantado, y por qué. */
const CRECEN_CON_EL_RELOJ = {
  post_metric_snapshot: 'una lectura diaria por video con menos de 90 días',
  post_score: 'el video que cumplió 24 h desde la última corrida se puntúa',
};

/** Invariantes de las lecturas que la tercera pasada no puede romper. */
const INVARIANTES_DEL_RELOJ = `
  SELECT
    (SELECT count(*) FROM (
       SELECT post_id, age_hours, source FROM post_metric_snapshot
       GROUP BY post_id, age_hours, source HAVING count(*) > 1) d)          AS pares_repetidos,
    (SELECT count(*) FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
      WHERE s.source = 'api'
        AND abs(EXTRACT(EPOCH FROM (s.captured_at - p.published_at)) / 3600 - s.age_hours) > 0.01) AS edad_mal,
    (SELECT count(*) FROM (
       SELECT views - lag(views) OVER (PARTITION BY post_id ORDER BY age_hours) AS d
       FROM post_metric_snapshot WHERE source = 'api') x WHERE d < 0)         AS bajadas,
    (SELECT count(*) FROM (
       SELECT connection_id, day, source FROM account_metric_snapshot
       GROUP BY connection_id, day, source HAVING count(*) > 1) d)           AS dias_repetidos
`;

async function listSql(dir) {
  const files = await readdir(dir).catch(() => []);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

const pedidos = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a));
const verifyFiles = (await listSql(HERE)).filter(
  (f) => pedidos.length === 0 || pedidos.includes(f.replace('.sql', ''))
);
if (pedidos.length > 0 && verifyFiles.length !== pedidos.length) {
  console.error(`  ✗ No existe verify/${pedidos.find((p) => !verifyFiles.includes(`${p}.sql`))}.sql`);
  process.exit(1);
}

const db = await PGlite.create({ extensions: { citext, pg_trgm } });

// Como superusuario: lo que en Supabase hace el token de administración.
await db.exec(`
  CREATE EXTENSION IF NOT EXISTS citext;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE ROLE mc_migrator_test NOSUPERUSER;
  CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
  CREATE ROLE mc_app NOLOGIN;
  ALTER SCHEMA public OWNER TO mc_migrator_test;
  GRANT mc_migrator_test TO postgres;
`);

// Desde aquí, todo como el dueño del esquema (sin BYPASSRLS).
await db.exec('SET ROLE mc_migrator_test');

const migraciones = await listSql(MIGRATIONS_DIR);
for (const file of migraciones) {
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
  await db.exec('BEGIN');
  try {
    await db.exec(sql);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(`  ✗ migración ${file}: ${err.message}`);
    process.exit(1);
  }
}
console.log(`\n  ${migraciones.length} migraciones aplicadas como mc_migrator_test.`);

const seeds = await listSql(SEED_DIR);
console.log(`  seeds: ${seeds.join(', ')}\n`);

async function conteos() {
  // Los conteos se toman como superusuario para no depender de RLS.
  await db.exec('RESET ROLE');
  const tablas = (await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tablas) {
    const r = await db.query(`SELECT count(*)::int AS n FROM "${t}"`);
    if (r.rows[0].n > 0) out[t] = r.rows[0].n;
  }
  await db.exec('SET ROLE mc_migrator_test');
  return out;
}

/**
 * Corre todos los seeds una vez. `transformar` permite alterar el texto
 * antes de ejecutarlo (la pasada con el reloj adelantado).
 */
async function pasada(n, transformar = (sql) => sql) {
  for (const file of seeds) {
    const sql = transformar(await readFile(join(SEED_DIR, file), 'utf8'));
    const t0 = Date.now();
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`  ✗ seed ${file} (pasada ${n}): ${err.message}`);
      process.exit(1);
    }
    if (n === 1) console.log(`  ✓ ${file}  (${Date.now() - t0} ms)`);
  }
  return conteos();
}

/** Imprime la tabla de conteos de dos pasadas y dice si son idénticos. */
function comparar(a, b, etiquetaA, etiquetaB, { permitidas = {} } = {}) {
  const tablas = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  let ok = true;
  const detalle = [];
  console.log(`\n  tabla                          ${etiquetaA.padStart(8)}   ${etiquetaB.padStart(8)}`);
  console.log('  ' + '─'.repeat(52));
  for (const t of tablas) {
    const x = a[t] ?? 0;
    const y = b[t] ?? 0;
    let flag = '';
    if (x !== y) {
      if (permitidas[t] && y > x) {
        flag = `   + ${y - x} (${permitidas[t]})`;
      } else {
        flag = '   ✗ CAMBIÓ';
        ok = false;
        detalle.push(t);
      }
    }
    console.log(`  ${t.padEnd(30)} ${String(x).padStart(8)}   ${String(y).padStart(8)}${flag}`);
  }
  return { ok, detalle };
}

const primera = await pasada(1);
const segunda = await pasada(2);

const idem = comparar(primera, segunda, 'pasada 1', 'pasada 2');
console.log(idem.ok
  ? '\n  ✓ Idempotente: la segunda pasada no cambió ningún conteo.\n'
  : '\n  ✗ La segunda pasada cambió filas: el seed NO es idempotente.\n');

// Verificación de cifras, como el dueño del esquema (RLS activo).
let fallos = 0;
for (const file of verifyFiles) {
  console.log(`  ── verify/${file}`);
  const verifySql = await readFile(join(HERE, file), 'utf8');
  let resultados = [];
  try {
    resultados = await db.exec(verifySql);
  } catch (err) {
    console.error(`  ✗ verify/${file}: ${err.message}`);
    await db.close();
    process.exit(1);
  }
  for (const r of resultados) {
    if (!r.rows?.length) continue;
    if (r.fields?.length === 1 && r.fields[0].name === 'set_config') continue;
    console.table(r.rows);
    if (r.fields?.some((f) => f.name === 'ok')) {
      for (const row of r.rows) {
        if (row.ok === false) {
          fallos++;
          console.error(`  ✗ ${row.check_id ?? file}: la cifra no es la esperada`);
        }
      }
    }
  }
}
if (fallos > 0) console.error(`\n  ✗ ${fallos} comprobación(es) fallaron.\n`);
else if (verifyFiles.length > 0) console.log('\n  ✓ Todas las comprobaciones pasaron.\n');

// Tercera pasada: los mismos seeds, mañana. CURRENT_DATE y now() pasan
// a valer un día más; la base ya tiene lo de hoy. Lo que estaba anclado
// a "la primera corrida" no se mueve, y solo entran las lecturas nuevas.
const manana = (sql) => sql
  .replace(/\bCURRENT_DATE\b/g, "(CURRENT_DATE + 1)")
  .replace(/\bnow\(\)/g, "(now() + interval '1 day')");
console.log('  ── tercera pasada: los seeds otra vez, con el reloj un día adelante');
const tercera = await pasada(3, manana);
const reloj = comparar(segunda, tercera, 'pasada 2', 'mañana', { permitidas: CRECEN_CON_EL_RELOJ });

let invariantesOk = true;
await db.exec('RESET ROLE');
const inv = (await db.query(INVARIANTES_DEL_RELOJ)).rows[0];
await db.exec('SET ROLE mc_migrator_test');
console.log('');
console.table([inv]);
for (const [k, v] of Object.entries(inv)) {
  if (Number(v) !== 0) {
    invariantesOk = false;
    console.error(`  ✗ ${k} = ${v} después de sembrar al día siguiente`);
  }
}
if (reloj.ok && invariantesOk) {
  console.log('\n  ✓ Sembrar al día siguiente no desplaza fechas, no duplica lecturas ni baja ninguna curva.\n');
} else {
  console.error(`\n  ✗ Sembrar al día siguiente corrompe la demo${reloj.detalle.length ? ` (cambió: ${reloj.detalle.join(', ')})` : ''}.\n`);
}

await db.close();
process.exit(idem.ok && fallos === 0 && reloj.ok && invariantesOk ? 0 : 1);
