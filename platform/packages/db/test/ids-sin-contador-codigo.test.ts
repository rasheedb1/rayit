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
 *     encontró dos en resumen.ts y una en el README del worker).
 *   - `id` (o `<alias>.id`) como PRIMERA clave de un ORDER BY sobre una
 *     de las quince, en cualquier dirección: `ORDER BY id` daba el orden
 *     de escritura y desde 0082 da uno al azar (la ronda 3 encontró uno
 *     en el manual de CON-8). Como último desempate, detrás de claves con
 *     significado (`ORDER BY called_at, s.id`), se acepta: solo hace que
 *     el resultado no dependa del plan.
 *   Los dos de ORDER BY también miran los .md: una consulta de un manual
 *   se copia tal cual.
 * Las migraciones aplicadas (hasta 0082) son inmutables y no se miran; las
 * que vengan después, sí.
 *
 * Y una tercera prueba mira lo que el grep de arriba no ve: el id de una
 * fila de las quince guardado DENTRO de un jsonb, donde ninguna clave
 * ajena lo protege (la ronda 4 encontró que el perfil comercial citaba
 * account_metric_snapshot por su número y 0082 no lo traducía). Cada
 * `table: '<convertida>'` (o `'table', '<convertida>'` en SQL) y cada
 * clave `<convertida>_id` / `<convertida>Id` en packages/core,
 * packages/db y apps tiene que estar declarada en REFERENCIAS_EN_JSON
 * con la ruta que 0082 traduce: así cada referencia nueva obliga a
 * decidir si una migración la convierte.
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
/**
 * Las referencias a una fila de las quince que viven dentro de un jsonb,
 * sin clave ajena, y lo que hace 0082 con cada una. `escribe` es el
 * archivo que la escribe y `marca` lo que tiene que seguir apareciendo en
 * él: si desaparece, la declaración sobra y la prueba lo dice.
 */
const REFERENCIAS_EN_JSON: ReadonlyArray<{ tabla: string; ruta: string; traduce: string; escribe: string; marca: RegExp }> = [
  {
    tabla: 'job_run',
    ruta: "audit_log.after -> '_job' ->> 'runId'",
    traduce: '0082 §2a (job_run.id_nuevo)',
    escribe: 'packages/db/src/audit.ts',
    marca: /\brunId\b/,
  },
  {
    tabla: 'account_metric_snapshot',
    ruta: "creator_profile.media_kit #> '{perfil_comercial,perfil,claims}' -> [] -> 'source' ->> 'id'",
    traduce: '0082 §2a (account_metric_snapshot.id_nuevo)',
    escribe: 'packages/core/src/outreach/perfil.ts',
    marca: /table: 'account_metric_snapshot'/,
  },
];

const camel = (t: string) => t.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
/** `table: 'x'`, `table: "x"` y `'table', 'x'` (jsonb_build_object), con x una de las quince. */
const CITA_DE_TABLA = new RegExp(`\\btable['"]?\\s*[:,]\\s*['"](${CONVERTIDAS.join('|')})['"]`, 'g');
/** Una clave que nombra una fila de las quince por su id: job_run_id, jobRunId. */
const CLAVE_DE_FILA = new RegExp(
  `\\b(?:(${CONVERTIDAS.join('|')})_id|(${CONVERTIDAS.map(camel).join('|')})Id)\\b`,
  'g',
);
/** Dónde se buscan: el código que escribe jsonb, y sus pruebas. */
const RAICES_JSON = ['packages/core', 'packages/db', 'apps'];

/** Las tablas convertidas que una línea cita como referencia dentro de un JSON. */
function referenciasEnJson(linea: string): string[] {
  const codigo = sinComentario(linea);
  const tablas: string[] = [];
  for (const m of codigo.matchAll(CITA_DE_TABLA)) tablas.push(m[1]!);
  for (const m of codigo.matchAll(CLAVE_DE_FILA)) {
    tablas.push(m[1] ?? CONVERTIDAS.find((t) => camel(t) === m[2])!);
  }
  return tablas;
}

/** Cuántas líneas hacia atrás se busca el FROM/JOIN que da el alias del ORDER BY. */
const VENTANA = 25;
/** Las dos formas de ordenar por el id como si dijera cuál fue antes. */
const ORDEN_POR_ID: ReadonlyArray<{ nombre: string; re: RegExp }> = [
  // `id DESC` en cualquier posición: era «la última que se escribió».
  { nombre: 'id DESC', re: /(?:ORDER BY|,)\s*(?:(\w+)\.)?id\s+DESC\b/gi },
  // `id` como primera clave, ASC o DESC: era el orden de escritura. Detrás
  // de una coma (último desempate) no cuenta.
  { nombre: 'id como primera clave', re: /ORDER BY\s+(?:(\w+)\.)?id\b(?!_)/gi },
];

/**
 * Un ORDER BY por el id que hace de orden sobre una tabla convertida. El
 * alias del ORDER BY se resuelve contra el FROM/JOIN de las líneas de
 * arriba: `s.id DESC` es hallazgo si `s` es post_metric_snapshot, no si
 * es notification_ack (que nació con uuid y desempata con su fecha). Sin
 * alias, manda el ÚLTIMO FROM antes del ORDER BY, que es el de su
 * consulta: `FROM post ORDER BY id` no es hallazgo aunque unas líneas
 * más arriba otra consulta lea post_metric_snapshot.
 */
function ordenPorIdSobreConvertida(lineas: readonly string[], i: number): string | null {
  const codigo = sinComentario(lineas[i]!);
  const arriba = lineas.slice(Math.max(0, i - VENTANA), i).map(sinComentario).join('\n');
  const tablas = CONVERTIDAS.join('|');
  for (const { nombre, re: orden } of ORDEN_POR_ID) {
    for (const m of codigo.matchAll(orden)) {
      const alias = m[1];
      const antes = `${arriba}\n${codigo.slice(0, m.index)}`;
      let tabla: string | undefined;
      if (alias) {
        const re = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:public\\.)?(${tablas})\\s+(?:AS\\s+)?${alias}\\b`, 'i');
        tabla = re.exec(antes)?.[1];
      } else {
        const ultimo = [...antes.matchAll(/\bFROM\s+(?:public\.)?(\w+)/gi)].at(-1)?.[1]?.toLowerCase();
        tabla = ultimo && CONVERTIDAS.includes(ultimo) ? ultimo : undefined;
      }
      if (tabla) return `${alias ? `${alias}.` : ''}${nombre} sobre ${tabla}`;
    }
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
        const orden = ordenPorIdSobreConvertida(lineas, i);
        if (orden) hallazgos.push(`${rel}:${i + 1} ${orden}: ${linea.trim()}`);
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

test('los patrones de ORDER BY id encuentran lo que las rondas 2 y 3 dejaron vivo, y no confunden las tablas que nacieron con uuid', () => {
  const caza = (sql: string) => {
    const lineas = sql.split('\n');
    return lineas.some((_, i) => ordenPorIdSobreConvertida(lineas, i) !== null);
  };
  const vivos = [
    // resumen.ts (listKnownPosts), con el FROM unas líneas arriba.
    'SELECT s.captured_at, s.views\n  FROM post_metric_snapshot s\n WHERE s.post_id = p.id\n ORDER BY s.captured_at DESC, s.id DESC\n LIMIT 1',
    // importCsvReadings, todo en una línea.
    '(SELECT s.* FROM post_metric_snapshot s WHERE s.post_id = p.id ORDER BY s.captured_at DESC, s.id DESC LIMIT 1) u',
    // El README del worker, sin alias.
    'SELECT id, job_id FROM job_run ORDER BY id DESC LIMIT 20;',
    'FROM audit_log AS a JOIN deal d ON true ORDER BY a.created_at DESC, a.id DESC',
    // El manual de CON-8 (ronda 3): el id como única clave, ascendente.
    "SELECT endpoint, ok, http_status FROM api_call_log\n WHERE connection_id = '<id>' ORDER BY id;",
    // Primera clave con alias, en cualquier dirección.
    'SELECT j.job_id FROM job_run j ORDER BY j.id, j.started_at',
    'FROM deal_stage_history h WHERE true ORDER BY h.id ASC',
  ];
  for (const v of vivos) assert.ok(caza(v), v);
  const bien = [
    // notification_ack y notification nacieron con uuid y desempatan con su fecha antes.
    'SELECT a.action FROM notification_ack a WHERE true ORDER BY a.created_at DESC, a.id DESC LIMIT 1',
    // El desempate final ascendente, detrás de criterios con significado.
    'FROM post_metric_snapshot s ORDER BY s.captured_at DESC, s.age_hours DESC, s.id',
    // Lo que el arreglo deja.
    'FROM job_run ORDER BY started_at DESC, finished_at DESC NULLS FIRST LIMIT 20;',
    "FROM api_call_log WHERE connection_id = '<id>' ORDER BY called_at, endpoint;",
    // El id como último desempate, ascendente, detrás de una fecha.
    'FROM job_run ORDER BY started_at, finished_at NULLS LAST, id',
    // Una columna que empieza por id no es el id.
    'FROM post_metric_snapshot s ORDER BY s.id_externo',
    // Una tabla que nació con uuid, el id como primera clave: no es un contador.
    'SELECT n.id FROM notification_ack n ORDER BY n.id',
    // La consulta de abajo lee otra tabla: manda su FROM, no el de la de arriba.
    "SELECT * FROM post_metric_snapshot;\nSELECT id, first_seen_at FROM post ORDER BY id",
    '-- FROM job_run ORDER BY id DESC (un comentario no cuenta)',
  ];
  for (const b of bien) assert.ok(!caza(b), b);
});

test('toda referencia a una fila de las quince dentro de un jsonb está declarada, con la ruta que 0082 traduce', async () => {
  const declaradas = new Set(REFERENCIAS_EN_JSON.map((r) => r.tabla));
  const sinDeclarar: string[] = [];
  const vistas = new Set<string>();
  for (const raiz of RAICES_JSON) {
    for await (const ruta of archivos(join(PLATFORM, raiz))) {
      if (!CODIGO.test(ruta)) continue;
      const rel = relative(PLATFORM, ruta);
      if (rel === 'packages/db/test/ids-sin-contador-codigo.test.ts') continue;
      const lineas = (await readFile(ruta, 'utf8')).split('\n');
      lineas.forEach((linea, i) => {
        for (const tabla of referenciasEnJson(linea)) {
          vistas.add(tabla);
          if (!declaradas.has(tabla)) sinDeclarar.push(`${rel}:${i + 1} ${tabla}: ${linea.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(
    sinDeclarar,
    [],
    'una fila de una tabla convertida citada por su id dentro de un jsonb no tiene clave ajena que la siga: ' +
      'si su id vuelve a cambiar, la cita queda colgada. Decide si una migración la traduce (patrón de 0082 §2a) ' +
      'y declárala en REFERENCIAS_EN_JSON con su ruta',
  );
  // Cada declaración sigue viva: su escritor la escribe todavía.
  for (const r of REFERENCIAS_EN_JSON) {
    const texto = await readFile(join(PLATFORM, r.escribe), 'utf8');
    assert.match(texto, r.marca, `REFERENCIAS_EN_JSON: ${r.tabla} (${r.ruta}) ya no la escribe ${r.escribe}; sobra`);
  }
  // La del perfil se ve en el código: el patrón no está mirando en otra parte.
  assert.ok(vistas.has('account_metric_snapshot'), [...vistas].join(', '));
  // Y la migración que las traduce reescribe las dos rutas declaradas.
  const nombre = (await readdir(join(PLATFORM, 'db/migrations'))).find((f) => f.endsWith('_ids_sin_contador.sql'))!;
  const migracion = await readFile(join(PLATFORM, 'db/migrations', nombre), 'utf8');
  assert.match(migracion, /'\{_job,runId\}'/);
  assert.match(migracion, /'\{perfil_comercial,perfil,claims\}'/);
});

test('el patrón de referencias en JSON encuentra la cita del perfil (ronda 4) y las formas parecidas, y no confunde otras tablas', () => {
  const vivos: Array<[string, string]> = [
    // perfil.ts:748, la que 0082 no traducía hasta la ronda 5.
    ["source: { table: 'account_metric_snapshot', id: c.followersSnapshotId, field: 'followers', asOf: c.followersDay },", 'account_metric_snapshot'],
    ['ref: { table: "idea_evidence", id: e.id }', 'idea_evidence'],
    ["jsonb_build_object('table', 'post_metric_snapshot', 'id', s.id::text)", 'post_metric_snapshot'],
    ['after: { ...after, job_run_id: runId }', 'job_run'],
    ['metadata: { preflightResultId: r.id }', 'preflight_result'],
  ];
  for (const [v, tabla] of vivos) assert.deepEqual(referenciasEnJson(v), [tabla], v);
  const bien = [
    "source: { table: 'audience_breakdown', id: a.id, field: 'share', asOf: a.day },",
    "const ref = { table: 'creator_baseline', id: b.id };",
    'SELECT id FROM account_metric_snapshot WHERE connection_id = $1',
    "// source: { table: 'job_run', id } (un comentario no cuenta)",
  ];
  for (const b of bien) assert.deepEqual(referenciasEnJson(b), [], b);
});
