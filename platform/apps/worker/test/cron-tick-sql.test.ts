/**
 * CIM-7 · el SQL del disparador (db/ops/cron-tick*.sql) y su relleno
 * (db/ops/render.mjs).
 *
 * pg_cron, pg_net y Vault no existen en pglite, así que el SQL no se
 * ejecuta aquí; se comprueba lo que sí se puede sin Supabase: que no
 * lleva un secreto en claro, que el secreto solo entra en Vault y la
 * tarea lo lee de ahí (en cron.job no queda el valor), que es idempotente
 * por construcción, y que el relleno valida lo que mete en los literales
 * y no filtra el secreto cuando falla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPS = fileURLToPath(new URL('../../../db/ops/', import.meta.url));
const leer = (f: string) => readFileSync(`${OPS}${f}`, 'utf8');
const PLANTILLAS = ['cron-tick.sql', 'cron-tick-estado.sql', 'cron-tick-quitar.sql'] as const;
const SECRETO = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'.repeat(2); // 64, como `openssl rand -hex 32`

/** Lo que va entre $tick$ y $tick$: el comando que queda guardado en cron.job. */
function comandoDeLaTarea(sql: string): string {
  const m = /\$tick\$([\s\S]*?)\$tick\$/.exec(sql);
  assert.ok(m, 'la tarea va entre $tick$');
  return m[1]!;
}

function rellenar(env: Record<string, string>) {
  return spawnSync(process.execPath, [`${OPS}render.mjs`, `${OPS}cron-tick.sql`], {
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
  assert.doesNotMatch(leer('cron-tick-estado.sql'), /decrypted_secret/, 'el estado mira que el secreto exista, nunca su valor');
});

test('el secreto solo entra en Vault; la tarea lo lee de vault.decrypted_secrets al disparar', () => {
  const sql = leer('cron-tick.sql');
  const comando = comandoDeLaTarea(sql);
  assert.doesNotMatch(comando, /\{\{CRON_SECRET\}\}/, 'en cron.job no queda el valor');
  assert.match(comando, /'Bearer ' \|\| \(SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'on_cue_cron_secret'\)/);
  assert.match(comando, /net\.http_post\(\s*url := '\{\{APP_URL\}\}\/api\/cron\/tick'/);
  const usos = [...sql.matchAll(/\{\{CRON_SECRET\}\}/g)].map((m) => sql.slice(Math.max(0, m.index - 40), m.index));
  assert.equal(usos.length, 2);
  assert.match(usos[0]!, /vault\.create_secret\('$/);
  assert.match(usos[1]!, /vault\.update_secret\(v_id, '$/);
});

test('idempotente: extensiones si faltan, secreto creado o actualizado, y la tarea anterior fuera antes de programarla', () => {
  const sql = leer('cron-tick.sql');
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_cron;/);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_net;/);
  const quitar = sql.indexOf("SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick';");
  const programar = sql.indexOf("SELECT cron.schedule(\n  'on-cue-tick',\n  '* * * * *',");
  assert.ok(quitar > 0 && programar > quitar, 'unschedule (si existe) antes de schedule: dos corridas dejan una tarea');
  assert.match(leer('cron-tick-quitar.sql'), /cron\.unschedule\(jobid\) FROM cron\.job WHERE jobname = 'on-cue-tick'/);
});

test('el relleno: el secreto aparece solo en las llamadas a Vault, y la URL, solo en la tarea', () => {
  const r = rellenar({ APP_URL: 'https://on-cue-web.vercel.app/', CRON_SECRET: SECRETO });
  assert.equal(r.status, 0, r.stderr);
  const sql = r.stdout;
  assert.doesNotMatch(sql, /\{\{[A-Z_]+\}\}/);
  assert.equal(sql.split(SECRETO).length - 1, 2);
  assert.ok(!comandoDeLaTarea(sql).includes(SECRETO), 'ni rellenado queda el secreto en el comando de la tarea');
  assert.match(comandoDeLaTarea(sql), /url := 'https:\/\/on-cue-web\.vercel\.app\/api\/cron\/tick'/, 'el origen, sin la barra final');
});

test('el relleno rechaza lo que no cabe en un literal, y al fallar no repite el secreto', () => {
  const casos: Array<[Record<string, string>, RegExp]> = [
    [{ APP_URL: 'https://on-cue-web.vercel.app', CRON_SECRET: `${SECRETO.slice(0, 40)}';DROP` }, /CRON_SECRET/],
    [{ APP_URL: 'https://on-cue-web.vercel.app', CRON_SECRET: 'corto' }, /openssl rand -hex 32/],
    [{ APP_URL: 'https://on-cue-web.vercel.app' }, /CRON_SECRET/],
    [{ APP_URL: 'http://on-cue-web.vercel.app', CRON_SECRET: SECRETO }, /https/],
    [{ APP_URL: 'https://on-cue-web.vercel.app/api', CRON_SECRET: SECRETO }, /solo el origen/],
    [{ APP_URL: "https://x.test/'||pg_sleep(1)||'", CRON_SECRET: SECRETO }, /solo el origen/],
    [{ APP_URL: 'no es una url', CRON_SECRET: SECRETO }, /no es una URL/],
  ];
  for (const [env, motivo] of casos) {
    const r = rellenar(env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.equal(r.stdout, '', 'nada a la salida: nada llega a Supabase');
    assert.match(r.stderr, motivo);
    if (env['CRON_SECRET']) assert.ok(!r.stderr.includes(env['CRON_SECRET']), 'el mensaje no repite el secreto');
  }
});
