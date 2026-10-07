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
 *   - `id DESC` (o `<alias>.id DESC`) en un ORDER BY sobre una de las
 *     quince tablas convertidas: era «la última que se escribió», y con
 *     un uuid al azar el desempate cambia entre corridas (la ronda 2
 *     encontró dos en resumen.ts y una en el README del worker). Este
 *     también mira los .md: una consulta de un manual se copia tal cual.
 * Las migraciones aplicadas (hasta 0082) son inmutables y no se miran; las
 * que vengan después, sí.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = fileURLToPath(new URL('../../../', import.meta.url));
const RAICES = ['apps', 'packages', 'db', 'scripts', '../docs'];
const CODIGO = /\.(ts|tsx|mts|mjs|js|sql)$/;
const EXTENSIONES = /\.(ts|tsx|mts|mjs|js|sql|md)$/;
const SALTAR = new Set(['node_modules', '.next', '.turbo', 'dist', 'fixtures', '.vercel']);
/** La última migración que ya no se puede tocar: 0082 es la que convierte. */
const ULTIMA_INMUTABLE = 82;

const PATRONES: ReadonlyArray<{ nombre: string; re: RegExp }> = [
  { nombre: 'Number(x.id)', re: /\bNumber\(\s*[\w.?!\]\[]*\.(id|runId)\s*\)/ },
  { nombre: 'BigInt(… id …)', re: /\bBigInt\([^()]*\b(id|runId)\b/ },
  { nombre: 'max/min(id)', re: /\b(max|min)\(\s*(\w+\.)?id\s*\)/i },
];

/** Las quince tablas que 0082 pasó de `id bigserial` a uuid. */
const CONVERTIDAS = [
  'account_metric_snapshot', 'api_call_log', 'api_quota_usage', 'audit_log', 'brand_account_snapshot',
  'deal_stage_history', 'external_post_snapshot', 'idea_evidence', 'job_run', 'post_engagement_curve',
  'post_impression_source', 'post_metric_snapshot', 'post_retention_curve', 'preflight_result',
  'video_onscreen_text',
];
/** Cuántas líneas hacia atrás se busca el FROM/JOIN que da el alias del ORDER BY. */
const VENTANA = 25;
const ID_DESC = /(?:ORDER BY|,)\s*(?:(\w+)\.)?id\s+DESC\b/gi;

/**
 * `id DESC` como desempate sobre una tabla convertida. El alias del
 * ORDER BY (o ninguno) se resuelve contra el FROM/JOIN de las líneas de
 * arriba: `s.id DESC` es hallazgo si `s` es post_metric_snapshot, no si
 * es notification_ack (que nació con uuid y desempata con su fecha).
 */
function idDescSobreConvertida(lineas: readonly string[], i: number): string | null {
  const codigo = sinComentario(lineas[i]!);
  const contexto = lineas.slice(Math.max(0, i - VENTANA), i + 1).map(sinComentario).join('\n');
  for (const m of codigo.matchAll(ID_DESC)) {
    const alias = m[1];
    const tablas = CONVERTIDAS.join('|');
    const re = alias
      ? new RegExp(`\\b(?:FROM|JOIN)\\s+(?:public\\.)?(${tablas})\\s+(?:AS\\s+)?${alias}\\b`, 'i')
      : new RegExp(`\\b(?:FROM|JOIN)\\s+(?:public\\.)?(${tablas})\\b`, 'i');
    const t = re.exec(contexto);
    if (t) return `${alias ? `${alias}.` : ''}id DESC sobre ${t[1]}`;
  }
  return null;
}

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
      const esCodigo = CODIGO.test(ruta);
      lineas.forEach((linea, i) => {
        const codigo = sinComentario(linea);
        if (esCodigo) for (const p of PATRONES) if (p.re.test(codigo)) hallazgos.push(`${rel}:${i + 1} ${p.nombre}: ${linea.trim()}`);
        const desc = idDescSobreConvertida(lineas, i);
        if (desc) hallazgos.push(`${rel}:${i + 1} ${desc}: ${linea.trim()}`);
      });
    }
  }
  assert.ok(mirados > 500, `se miraron ${mirados} archivos: la ruta de la plataforma está mal`);
  assert.deepEqual(
    hallazgos,
    [],
    'un id uuid no es un número ni dice cuál fue antes: ordena por fecha (started_at, created_at, called_at), por step, ' +
      'o con ORDEN_ULTIMA_CORRIDA / ORDEN_ULTIMA_LECTURA',
  );
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

test('el patrón de id DESC encuentra lo que la ronda 2 dejó vivo, y no confunde las tablas que nacieron con uuid', () => {
  const caza = (sql: string) => {
    const lineas = sql.split('\n');
    return lineas.some((_, i) => idDescSobreConvertida(lineas, i) !== null);
  };
  const vivos = [
    // resumen.ts (listKnownPosts), con el FROM unas líneas arriba.
    'SELECT s.captured_at, s.views\n  FROM post_metric_snapshot s\n WHERE s.post_id = p.id\n ORDER BY s.captured_at DESC, s.id DESC\n LIMIT 1',
    // importCsvReadings, todo en una línea.
    '(SELECT s.* FROM post_metric_snapshot s WHERE s.post_id = p.id ORDER BY s.captured_at DESC, s.id DESC LIMIT 1) u',
    // El README del worker, sin alias.
    'SELECT id, job_id FROM job_run ORDER BY id DESC LIMIT 20;',
    'FROM audit_log AS a JOIN deal d ON true ORDER BY a.created_at DESC, a.id DESC',
  ];
  for (const v of vivos) assert.ok(caza(v), v);
  const bien = [
    // notification_ack y notification nacieron con uuid y desempatan con su fecha antes.
    'SELECT a.action FROM notification_ack a WHERE true ORDER BY a.created_at DESC, a.id DESC LIMIT 1',
    // El desempate final ascendente, detrás de criterios con significado.
    'FROM post_metric_snapshot s ORDER BY s.captured_at DESC, s.age_hours DESC, s.id',
    // Lo que el arreglo deja.
    'FROM job_run ORDER BY started_at DESC, finished_at DESC NULLS FIRST LIMIT 20;',
    '-- FROM job_run ORDER BY id DESC (un comentario no cuenta)',
  ];
  for (const b of bien) assert.ok(!caza(b), b);
});
