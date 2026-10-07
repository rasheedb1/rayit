/**
 * CIM-11 · Ningún código trata como número un id que desde 0082 es un uuid.
 *
 * La revisión de la ronda 1 encontró dos que la conversión dejó vivos sin
 * que ninguna prueba se pusiera roja: `max(id)` y `BigInt(id)` en la
 * espera de la demo del worker (Postgres no tiene max(uuid)), y
 * `Number(r.id)` en una prueba de la cadena CON-5 → CON-6, donde cada
 * valor era NaN y deepStrictEqual daba por ordenada una lista de NaN. Esta
 * prueba es el grep de la historia: recorre el código de la plataforma y
 * falla con el archivo y la línea si vuelve a aparecer una de esas formas.
 *
 * Lo que mira (fuera de comentarios):
 *   - Number(x.id) y Number(x.runId): un uuid da NaN.
 *   - BigInt(… id …) y BigInt(… runId …): un uuid lanza SyntaxError.
 *   - max(id), min(id), max(t.id), min(t.id) en SQL: no existe para uuid.
 * Las migraciones aplicadas (hasta 0082) son inmutables y no se miran; las
 * que vengan después, sí.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = fileURLToPath(new URL('../../../', import.meta.url));
const RAICES = ['apps', 'packages', 'db/ops', 'db/seed', 'db/migrations', 'scripts'];
const EXTENSIONES = /\.(ts|tsx|mts|mjs|js|sql)$/;
const SALTAR = new Set(['node_modules', '.next', '.turbo', 'dist', 'fixtures', '.vercel']);
/** La última migración que ya no se puede tocar: 0082 es la que convierte. */
const ULTIMA_INMUTABLE = 82;

const PATRONES: ReadonlyArray<{ nombre: string; re: RegExp }> = [
  { nombre: 'Number(x.id)', re: /\bNumber\(\s*[\w.?!\]\[]*\.(id|runId)\s*\)/ },
  { nombre: 'BigInt(… id …)', re: /\bBigInt\([^()]*\b(id|runId)\b/ },
  { nombre: 'max/min(id)', re: /\b(max|min)\(\s*(\w+\.)?id\s*\)/i },
];

async function* archivos(dir: string): AsyncGenerator<string> {
  let entradas;
  try {
    entradas = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entradas) {
    if (SALTAR.has(e.name)) continue;
    const ruta = join(dir, e.name);
    if (e.isDirectory()) yield* archivos(ruta);
    else if (EXTENSIONES.test(e.name)) yield ruta;
  }
}

/** Quita el comentario de la línea (// y -- al final, y las líneas de bloque que empiezan por * o /*). */
function sinComentario(linea: string): string {
  const t = linea.trim();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('--')) return '';
  return linea.replace(/\s\/\/.*$/, '').replace(/\s--\s.*$/, '');
}

test('ningún código trata como número un id que es uuid (el grep de CIM-11)', async () => {
  const hallazgos: string[] = [];
  let mirados = 0;
  for (const raiz of RAICES) {
    for await (const ruta of archivos(join(PLATFORM, raiz))) {
      const rel = relative(PLATFORM, ruta);
      const migracion = /^db\/migrations\/(\d{4})_/.exec(rel);
      if (migracion && Number(migracion[1]) <= ULTIMA_INMUTABLE) continue;
      if (rel === 'packages/db/test/ids-sin-contador-codigo.test.ts') continue;
      mirados++;
      const lineas = (await readFile(ruta, 'utf8')).split('\n');
      lineas.forEach((linea, i) => {
        const codigo = sinComentario(linea);
        for (const p of PATRONES) if (p.re.test(codigo)) hallazgos.push(`${rel}:${i + 1} ${p.nombre}: ${linea.trim()}`);
      });
    }
  }
  assert.ok(mirados > 500, `se miraron ${mirados} archivos: la ruta de la plataforma está mal`);
  assert.deepEqual(hallazgos, [], 'un id uuid no es un número: ordena por fecha (started_at, created_at, called_at) o por step');
});

test('los patrones del grep encuentran lo que la ronda 1 dejó vivo', () => {
  const vivos = [
    "const orden = [collect1, base1].map((r) => Number(r.id));",
    // La demo convertía con BigInt(v) un valor que salía de max(id): el
    // grep la caza por el max(id) de la consulta.
    'SELECT max(id)::text AS ultimo FROM job_run',
    'const n = BigInt(row.id);',
    'await cerrar(BigInt(runId));',
    "max(j.id) FILTER (WHERE job_id = 'collect.post_metrics')",
    'return { runId: Number(rows[0]?.runId) };',
  ];
  for (const v of vivos) {
    assert.ok(PATRONES.some((p) => p.re.test(sinComentario(v))), v);
  }
  // Y no confunde lo que sí es un número.
  for (const bien of ['Number(r.n)', 'BigInt(views)', 'max(started_at)', 'Number(r.step)', 'count(DISTINCT id)']) {
    assert.ok(!PATRONES.some((p) => p.re.test(bien)), bien);
  }
});
