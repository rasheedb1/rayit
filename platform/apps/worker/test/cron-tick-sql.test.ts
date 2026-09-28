/**
 * CIM-7 · el SQL del disparador (db/ops/cron-tick*.sql) y su relleno
 * (db/ops/render.mjs).
 *
 * pg_cron, pg_net y Vault no existen en pglite, así que el SQL no se
 * ejecuta aquí; se comprueba lo que sí se puede sin Supabase: que no
 * lleva un secreto en claro, que el secreto solo entra en Vault, en su
 * propia llamada y con SELECT que pg_stat_statements normaliza (nada de
 * DO), que la tarea lo lee de ahí (en cron.job no queda el valor), que es
 * idempotente por construcción, y que el relleno valida lo que mete en
 * los literales y no filtra el secreto cuando falla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPS = fileURLToPath(new URL('../../../db/ops/', import.meta.url));
const leer = (f: string) => readFileSync(`${OPS}${f}`, 'utf8');
const PLANTILLAS = ['cron-tick.sql', 'cron-tick-secreto.sql', 'cron-tick-estado.sql', 'cron-tick-quitar.sql', 'cron-tick-huellas.sql'] as const;
const SECRETO = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'.repeat(2); // 64, como `openssl rand -hex 32`

/** Lo que va entre $tick$ y $tick$: el comando que queda guardado en cron.job. */
function comandoDeLaTarea(sql: string): string {
  const m = /\$tick\$([\s\S]*?)\$tick\$/.exec(sql);
  assert.ok(m, 'la tarea va entre $tick$');
  return m[1]!;
}

/** Las sentencias de un lote, sin comentarios: lo que llega a Postgres. */
function sentencias(sql: string): string[] {
  return sql.replace(/--[^\n]*/g, '').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
}

function rellenar(plantilla: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [`${OPS}render.mjs`, `${OPS}${plantilla}`], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
  });
}

test('las plantillas no llevan nada que parezca un secreto', () => {
  for (const f of PLANTILLAS) {
    const sql = leer(f);
    assert.doesNotMatch(sql, /\b[0-9a-f]{32,}\b/i, `${f}: sin cadenas hexadecimales largas`);
    assert.doesNotMatch(sql, /[A-Za-z0-9+/]{40,}={0,2}/, `${f}: sin base64 largo`);
    assert.doesNotMatch(sql, /Bearer [A-Za-z0-9_-]{16,}/, `${f}: ningún Bearer con un valor escrito`);
    assert.doesNotMatch(sql, /(sbp_|eyJ|postgres(ql)?:\/\/)/, `${f}: ni tokens de Supabase, ni JWT, ni cadenas de conexión`);
  }
  for (const f of ['cron-tick-estado.sql', 'cron-tick-huellas.sql']) {
    assert.doesNotMatch(leer(f), /decrypted_secret/, `${f}: mira que el secreto exista, nunca su valor`);
  }
});

test('el secreto va en su propia llamada, con dos SELECT de nivel superior y nada más (sin DO)', () => {
  const tarea = leer('cron-tick.sql');
  assert.doesNotMatch(tarea, /\{\{CRON_SECRET\}\}/, 'el lote de la tarea no lleva el secreto: un fallo de pg_cron no lo arrastra al log');
  const secreto = leer('cron-tick-secreto.sql');
  assert.doesNotMatch(secreto, /\{\{APP_URL\}\}/);
  const s = sentencias(secreto);
  assert.equal(s.length, 2, s.join('\n---\n'));
  for (const x of s) {
    assert.match(x, /^SELECT vault\.(update|create)_secret\(/, 'SELECT de nivel superior: pg_stat_statements normaliza sus literales');
    assert.doesNotMatch(x, /\bDO\b|\$\$/, 'un DO se guarda tal cual en pg_stat_statements');
  }
  assert.match(s[0]!, /vault\.update_secret\(id, '\{\{CRON_SECRET\}\}'\) FROM vault\.secrets WHERE name = 'on_cue_cron_secret'$/);
  assert.match(s[1]!, /WHERE NOT EXISTS \(SELECT 1 FROM vault\.secrets WHERE name = 'on_cue_cron_secret'\)$/, 'crear solo si falta: idempotente');
  assert.equal([...secreto.matchAll(/\{\{CRON_SECRET\}\}/g)].length, 2, 'y en ningún comentario');
  // La tarea lo lee de Vault al disparar: en cron.job no queda el valor.
  assert.match(comandoDeLaTarea(tarea), /'Bearer ' \|\| \(SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'on_cue_cron_secret'\)/);
  assert.match(comandoDeLaTarea(tarea), /net\.http_post\(\s*url := '\{\{APP_URL\}\}\/api\/cron\/tick'/);
  // El lote de la tarea comprueba que Vault está, para que la llamada del secreto no tenga de qué fallar.
  assert.match(tarea, /to_regproc\('vault\.create_secret'\) IS NULL/);
});

test('install manda la tarea y el secreto en dos llamadas, valida el secreto antes de tocar nada y mira pg_stat_statements', () => {
  const sh = readFileSync(fileURLToPath(new URL('../../../scripts/cron-tick.sh', import.meta.url)), 'utf8');
  const validar = sh.indexOf('node db/ops/render.mjs db/ops/cron-tick-secreto.sql >/dev/null');
  const tarea = sh.indexOf('CRON_SECRET= node db/ops/render.mjs db/ops/cron-tick.sql');
  const secreto = sh.indexOf('APP_URL= node db/ops/render.mjs db/ops/cron-tick-secreto.sql');
  assert.ok(validar > 0 && tarea > validar && secreto > tarea, 'validar, la tarea (sin el secreto en su entorno), y el secreto aparte');
  assert.match(sh, /huellas\(\)/);
  assert.match(sh, /db\/ops\/cron-tick-huellas\.sql/);
  assert.match(leer('cron-tick-huellas.sql'), /pg_stat_statements_reset\(\)/, 'y dice cómo limpiarlo');
});

test('idempotente: extensiones si faltan y la tarea anterior fuera antes de programarla', () => {
  const sql = leer('cron-tick.sql');
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_cron;/);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_net;/);
  const quitar = sql.indexOf("SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick';");
  const programar = sql.indexOf("SELECT cron.schedule(\n  'on-cue-tick',\n  '* * * * *',");
  assert.ok(quitar > 0 && programar > quitar, 'unschedule (si existe) antes de schedule: dos corridas dejan una tarea');
  assert.match(leer('cron-tick-quitar.sql'), /cron\.unschedule\(jobid\) FROM cron\.job WHERE jobname = 'on-cue-tick'/);
});

test('el relleno: la URL solo en la tarea, el secreto solo en su lote', () => {
  const tarea = rellenar('cron-tick.sql', { APP_URL: 'https://on-cue-web.vercel.app/', CRON_SECRET: SECRETO });
  assert.equal(tarea.status, 0, tarea.stderr);
  assert.doesNotMatch(tarea.stdout, /\{\{[A-Z_]+\}\}/);
  assert.ok(!tarea.stdout.includes(SECRETO), 'ni con el secreto en el entorno llega al lote de la tarea');
  assert.match(comandoDeLaTarea(tarea.stdout), /url := 'https:\/\/on-cue-web\.vercel\.app\/api\/cron\/tick'/, 'el origen, sin la barra final');
  assert.equal(rellenar('cron-tick.sql', { APP_URL: 'https://on-cue-web.vercel.app' }).status, 0, 'la tarea no pide el secreto');

  const secreto = rellenar('cron-tick-secreto.sql', { CRON_SECRET: SECRETO });
  assert.equal(secreto.status, 0, secreto.stderr);
  assert.equal(secreto.stdout.split(SECRETO).length - 1, 2);
  assert.ok(!secreto.stdout.includes('vercel.app'), 'el lote del secreto no lleva nada más');
  assert.equal(rellenar('cron-tick-estado.sql', {}).status, 2, 'una plantilla sin marcadores no se rellena: se corre tal cual');
});

test('el relleno rechaza lo que no cabe en un literal, y al fallar no repite el secreto', () => {
  const casos: Array<[string, Record<string, string>, RegExp]> = [
    ['cron-tick-secreto.sql', { CRON_SECRET: `${SECRETO.slice(0, 40)}';DROP` }, /CRON_SECRET/],
    ['cron-tick-secreto.sql', { CRON_SECRET: 'corto' }, /openssl rand -hex 32/],
    ['cron-tick-secreto.sql', {}, /CRON_SECRET/],
    ['cron-tick.sql', { APP_URL: 'http://on-cue-web.vercel.app' }, /https/],
    ['cron-tick.sql', { APP_URL: 'https://on-cue-web.vercel.app/api' }, /solo el origen/],
    ['cron-tick.sql', { APP_URL: "https://x.test/'||pg_sleep(1)||'" }, /solo el origen/],
    ['cron-tick.sql', { APP_URL: 'no es una url' }, /no es una URL/],
  ];
  for (const [plantilla, env, motivo] of casos) {
    const r = rellenar(plantilla, env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.equal(r.stdout, '', 'nada a la salida: nada llega a Supabase');
    assert.match(r.stderr, motivo);
    if (env['CRON_SECRET']) assert.ok(!r.stderr.includes(env['CRON_SECRET']), 'el mensaje no repite el secreto');
  }
});
