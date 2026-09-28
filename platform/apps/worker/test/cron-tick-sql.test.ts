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
 * los literales y no filtra el secreto cuando falla. Y lo que hace
 * scripts/cron-tick.sh con las respuestas: no copia el secreto si la API
 * rechaza su lote, y `make cron.status` da un veredicto
 * (db/ops/cron-tick-veredicto.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_TICK_CUTS, TICK_CUT_KEY } from '@mc/db/queries/worker';
import { openTestDatabase } from './helpers/harness.ts';

const OPS = fileURLToPath(new URL('../../../db/ops/', import.meta.url));
const leer = (f: string) => readFileSync(`${OPS}${f}`, 'utf8');
const PLANTILLAS = ['cron-tick.sql', 'cron-tick-vault.sql', 'cron-tick-secreto.sql', 'cron-tick-estado.sql', 'cron-tick-quitar.sql', 'cron-tick-huellas.sql'] as const;
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
  // Vault se comprueba en su propio lote, sin secretos, para que la llamada del secreto no tenga de qué fallar.
  assert.match(leer('cron-tick-vault.sql'), /to_regproc\('vault\.create_secret'\) IS NULL/);
  assert.doesNotMatch(leer('cron-tick-vault.sql'), /\{\{[A-Z_]+\}\}/, 'sin marcadores: se manda tal cual');
  // Y si aun así falta, la tarea no dispara: nada de peticiones con 'Bearer ' || NULL.
  assert.match(comandoDeLaTarea(tarea), /\)\s*WHERE EXISTS \(SELECT 1 FROM vault\.decrypted_secrets WHERE name = 'on_cue_cron_secret' AND decrypted_secret IS NOT NULL\);\s*$/);
});

test('install valida todo antes de tocar nada, y guarda el secreto ANTES de programar la tarea; y mira pg_stat_statements', () => {
  const sh = readFileSync(fileURLToPath(new URL('../../../scripts/cron-tick.sh', import.meta.url)), 'utf8');
  const validar = sh.indexOf('node db/ops/render.mjs db/ops/cron-tick-secreto.sql >/dev/null');
  const rellenarTarea = sh.indexOf('tarea="$(CRON_SECRET= node db/ops/render.mjs db/ops/cron-tick.sql)"');
  const vault = sh.indexOf('admin_sql "$(cat db/ops/cron-tick-vault.sql)"');
  const secreto = sh.indexOf('APP_URL= node db/ops/render.mjs db/ops/cron-tick-secreto.sql');
  const programar = sh.indexOf('admin_sql "$tarea"');
  assert.ok(validar > 0 && rellenarTarea > validar, 'los dos rellenos (y sus validaciones) antes de la primera llamada');
  assert.ok(vault > rellenarTarea && secreto > vault && programar > secreto,
    'Vault, luego el secreto y al final la tarea: en una primera instalación pg_cron nunca dispara sin secreto');
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

test('la purga del historial de pg_cron: una semana, a diario, idempotente, y se retira con la tarea', () => {
  const sql = leer('cron-tick.sql');
  const quitar = sql.indexOf("SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick-purga';");
  const programar = sql.indexOf("SELECT cron.schedule(\n  'on-cue-tick-purga',\n  '17 3 * * *',");
  assert.ok(quitar > 0 && programar > quitar, 'unschedule antes de schedule: dos installs dejan una purga');
  assert.match(sql, /\$purga\$DELETE FROM cron\.job_run_details WHERE end_time < now\(\) - interval '7 days'\$purga\$/);
  assert.match(leer('cron-tick-quitar.sql'), /cron\.unschedule\(jobid\) FROM cron\.job WHERE jobname = 'on-cue-tick-purga'/);
  assert.match(leer('cron-tick-quitar.sql'), /jobname IN \('on-cue-tick', 'on-cue-tick-purga'\)/);
  assert.match(leer('cron-tick-estado.sql'), /'purga'/);
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

test('supabase-admin.sh no pone el token de administración en la línea de comandos de curl (saldría en `ps`)', () => {
  const sh = readFileSync(fileURLToPath(new URL('../../../scripts/supabase-admin.sh', import.meta.url)), 'utf8');
  const codigo = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(codigo, /-H\s+["']Authorization/, 'ninguna cabecera Authorization como argumento');
  assert.match(codigo, /--config <\(printf 'header = "Authorization: Bearer %s"\\n' "\$t"\)/, 'va por un descriptor, con printf (interno de bash)');
  assert.equal([...codigo.matchAll(/\bcurl\b/g)].length, 1, 'una sola llamada a curl, la de api()');
});

test('si la API rechaza la llamada del secreto, admin_sql --redactar no lo copia a la terminal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-tick-'));
  try {
    // Una API de administración de mentira que rechaza la consulta citando la sentencia, como Postgres (LINE 1: …).
    const falsa = join(dir, 'admin-falso.sh');
    writeFileSync(falsa, [
      '#!/usr/bin/env bash',
      'sql="$(cat)"',
      `python3 -c 'import json,sys; s=sys.argv[1].strip().splitlines()[0]; print(json.dumps({"message": "Failed to run sql query: ERROR:  42501: permission denied for function update_secret LINE 1: " + s}))' "$(printf '%s' "$sql" | grep -v '^--' | grep -v '^$')"`,
      '',
    ].join('\n'));
    chmodSync(falsa, 0o755);
    const lote = rellenar('cron-tick-secreto.sql', { CRON_SECRET: SECRETO }).stdout;
    const correr = (redactar: boolean) => spawnSync('bash', ['-c', `source scripts/cron-tick.sh; ADMIN="$FALSA"; admin_sql ${redactar ? '--redactar ' : ''}"$LOTE"`], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { PATH: process.env['PATH'] ?? '', FALSA: falsa, LOTE: lote, CRON_SECRET: SECRETO },
      encoding: 'utf8',
    });
    const sinRedactar = correr(false);
    assert.equal(sinRedactar.status, 1);
    assert.ok(sinRedactar.stderr.includes(SECRETO), 'la prueba es de verdad: la respuesta de la API trae el secreto');

    const r = correr(true);
    assert.equal(r.status, 1, 'sigue fallando: install se detiene');
    assert.equal(r.stdout, '');
    assert.ok(!r.stderr.includes(SECRETO), `el secreto no sale: ${r.stderr}`);
    assert.ok(!r.stderr.includes(SECRETO.slice(0, 32)), 'ni un trozo');
    assert.match(r.stderr, /rechazó la consulta del secreto/);
    assert.match(r.stderr, /permission denied for function update_secret LINE 1: SELECT vault\.update_secret\(id, '\*\*\*'\)/, 'el motivo sí, con *** en lugar del valor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const sh = readFileSync(fileURLToPath(new URL('../../../scripts/cron-tick.sh', import.meta.url)), 'utf8');
  assert.match(sh, /admin_sql --redactar "\$sql"/, 'install manda el lote del secreto por el modo que no copia la respuesta');
});

/** Una respuesta de pg_net de hace `hace` segundos, con el reloj de la base en AHORA. */
const AHORA = '2026-09-28T15:00:00+00:00';
const respuesta = (hace: number, status_code: number | null, extra: Record<string, unknown> = {}) => ({
  id: hace, status_code, timed_out: false, error_msg: null, created: new Date(Date.parse(AHORA) - hace * 1000).toISOString(),
  content: status_code === 200 ? `{"at":"2026-09-28T14:59:00.000Z","budgetMs":45000,"elapsedMs":${100 + hace},"ran":[]` : '{"ok":false}', ...extra,
});
const SANO = {
  ahora: AHORA,
  tarea: [{ jobid: 1, schedule: '* * * * *', active: true, command: '…' }],
  secreto_en_vault: [{ name: 'on_cue_cron_secret' }],
  ultimas_respuestas: [respuesta(20, 200), respuesta(80, 200)],
  cola_pg_net: 0,
  dispatch_ultimo_ok: '2026-09-28T14:58:00+00:00',
};

interface Veredicto { sano: boolean; lineas: Array<{ nivel: 'ok' | 'aviso' | 'error'; texto: string }> }

test('make cron.status da un veredicto: verde si todo responde 200, y en rojo qué hacer si no', async () => {
  const m = (await import(`${OPS}cron-tick-veredicto.mjs`)) as { veredicto: (e: unknown) => Veredicto; estadoDe: (r: unknown) => unknown };
  const ok = m.veredicto(m.estadoDe([{ cron_tick: SANO }]));
  assert.equal(ok.sano, true);
  assert.match(ok.lineas[0]!.texto, /El turno responde: 2 respuesta\(s\) 200 en 5 min, 150 ms de media/);

  const casos: Array<[string, Record<string, unknown>, RegExp]> = [
    ['secreto distinto', { ultimas_respuestas: [respuesta(20, 401), respuesta(80, 200)] }, /CRON_SECRET del Vault no es el de Vercel/],
    ['falla el turno', { ultimas_respuestas: [respuesta(20, 500)] }, /logs de Vercel \(\[cron\/tick\]\).*WORKER_DATABASE_URL/],
    ['no respondió a tiempo', { ultimas_respuestas: [respuesta(20, 504)] }, /no respondió a tiempo/],
    ['pg_net lo dio por perdido', { ultimas_respuestas: [respuesta(20, null, { timed_out: true })] }, /más que su maxDuration/],
    ['pg_cron no dispara', { ultimas_respuestas: [respuesta(400, 200)] }, /Ninguna respuesta de la ruta en 5 min: pg_cron no está disparando/],
    ['sin tarea', { tarea: null }, /on-cue-tick no existe/],
    ['tarea apagada', { tarea: [{ active: false }] }, /desactivada/],
    ['sin secreto', { secreto_en_vault: null }, /No hay secreto en Vault/],
    ['otra URL', { ultimas_respuestas: [respuesta(20, 404)] }, /respondió 404: mira APP_URL/],
  ];
  for (const [nombre, cambio, motivo] of casos) {
    const v = m.veredicto({ ...SANO, ...cambio });
    assert.equal(v.sano, false, nombre);
    assert.ok(v.lineas.some((l) => l.nivel === 'error' && motivo.test(l.texto)), `${nombre}: ${JSON.stringify(v.lineas)}`);
  }

  // Avisos que no tumban el chequeo: pg_net atascado (el secreto se queda en su cola) y el despacho parado.
  const atascado = m.veredicto({ ...SANO, cola_pg_net: 12, dispatch_ultimo_ok: '2026-09-28T13:00:00+00:00' });
  assert.equal(atascado.sano, true);
  assert.ok(atascado.lineas.some((l) => l.nivel === 'aviso' && /12 petición\(es\) sin enviar.*net\.http_request_queue/.test(l.texto)));
  assert.ok(atascado.lineas.some((l) => l.nivel === 'aviso' && /outbound\.dispatch fue hace 120 min/.test(l.texto)));
});

test('el veredicto por la línea de comandos: sale con 1 si no está sano, y no repite el cuerpo de las respuestas', () => {
  const correr = (estado: unknown) => spawnSync(process.execPath, [`${OPS}cron-tick-veredicto.mjs`], { input: JSON.stringify([{ cron_tick: estado }]), encoding: 'utf8' });
  const ok = correr(SANO);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /El turno responde/);
  const mal = correr({ ...SANO, ultimas_respuestas: [respuesta(20, 401, { content: 'Bearer abc' })] });
  assert.equal(mal.status, 1);
  assert.match(mal.stderr, /CRON_SECRET/);
  assert.ok(!`${mal.stdout}${mal.stderr}`.includes('Bearer abc'));
  const roto = spawnSync(process.execPath, [`${OPS}cron-tick-veredicto.mjs`], { input: 'no es json {', encoding: 'utf8' });
  assert.equal(roto.status, 1);
  const script = readFileSync(fileURLToPath(new URL('../../../scripts/cron-tick.sh', import.meta.url)), 'utf8');
  assert.match(script, /node db\/ops\/cron-tick-veredicto\.mjs \|\| sano=1/, 'status lo corre y sale con 1 si no está sano');
});

test('el estado cuenta la cola de pg_net (donde espera la cabecera con el secreto) y la última pasada buena de outbound.dispatch', () => {
  const estado = leer('cron-tick-estado.sql');
  assert.match(estado, /'cola_pg_net', \(SELECT count\(\*\) FROM net\.http_request_queue\)/);
  assert.match(estado, /'dispatch_ultimo_ok'/);
  assert.match(estado, /'ahora', now\(\)/);
  assert.match(leer('cron-tick.sql'), /net\.http_request_queue/, 'y la plantilla dice dónde queda la cabecera hasta que sale');
});

test(`jobs que no caben en el turno: ${MAX_TICK_CUTS} cortes seguidos sin terminar bien ponen el veredicto en rojo`, async () => {
  const m = (await import(`${OPS}cron-tick-veredicto.mjs`)) as { veredicto: (e: unknown) => Veredicto };
  const v = m.veredicto({ ...SANO, no_caben: [{ job_id: 'compute.baseline', cortes: 40 }] });
  assert.equal(v.sano, false);
  assert.ok(v.lineas.some((l) => l.nivel === 'error' && /No caben en el turno.*compute\.baseline \(40\).*opción A/.test(l.texto)), JSON.stringify(v.lineas));
  assert.equal(m.veredicto({ ...SANO, no_caben: null }).sano, true, 'la lista vacía (jsonb_agg de nada es null) no es un problema');

  // La consulta de verdad, contra Postgres embebido: el mismo tope que el runner, y solo los cortes desde la última buena.
  const estado = leer('cron-tick-estado.sql');
  assert.ok(estado.includes(`HAVING count(*) >= ${MAX_TICK_CUTS}`), 'el tope del SQL es MAX_TICK_CUTS');
  assert.ok(estado.includes(`'${TICK_CUT_KEY}'`), 'y la marca, TICK_CUT_KEY');
  const fragmento = /-- no_caben:inicio\n([\s\S]*?)\n\s*-- no_caben:fin/.exec(estado)?.[1];
  assert.ok(fragmento, 'las marcas del fragmento están en su sitio');
  const db = await openTestDatabase();
  try {
    await db.raw.exec(`
      INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
        ('test.nocabe', 'No cabe', 'test', '0 0 1 1 *', 60, 1, 1),
        ('test.retoma', 'Se retoma', 'test', '0 0 1 1 *', 60, 1, 1);
      -- test.nocabe: una buena y después ${MAX_TICK_CUTS} cortes. test.retoma: ${MAX_TICK_CUTS} cortes viejos y una buena después.
      INSERT INTO job_run (job_id, status, attempt, started_at, finished_at) VALUES
        ('test.nocabe', 'ok', 1, now() - interval '2 days', now() - interval '2 days'),
        ('test.retoma', 'ok', 1, now() - interval '1 minute', now() - interval '1 minute');
      INSERT INTO job_run (job_id, status, attempt, started_at, finished_at, error, metadata)
      SELECT j, 'failed', 1, now() - interval '1 day' + make_interval(mins => g), now(), 'timeout', '{"${TICK_CUT_KEY}": true}'::jsonb
        FROM unnest(ARRAY['test.nocabe', 'test.retoma']) j, generate_series(1, ${MAX_TICK_CUTS}) g;
      -- Un fallo de verdad no cuenta como corte del turno.
      INSERT INTO job_run (job_id, status, attempt, started_at, finished_at, error) VALUES ('test.retoma', 'failed', 1, now(), now(), 'Error: x');
    `);
    const { rows } = await db.raw.query<{ no_caben: unknown }>(`SELECT (${fragmento}) AS no_caben`);
    assert.deepEqual(rows[0]?.no_caben, [{ job_id: 'test.nocabe', cortes: MAX_TICK_CUTS }]);
  } finally {
    await db.close();
  }
});

test('la proyección contra los cupos de Hobby: avisa por encima de ~250 GB-h al mes y lo dice en verde por debajo', async () => {
  const m = (await import(`${OPS}cron-tick-veredicto.mjs`)) as {
    veredicto: (e: unknown) => Veredicto; gbhMes: (ms: number) => number; HOBBY: { invocacionesMes: number; cupoGbh: number; avisoGbh: number };
  };
  assert.equal(m.HOBBY.invocacionesMes, 43_200, 'una llamada por minuto, 30 días');
  assert.equal(m.gbhMes(10_000), 240, '10 s de media a 2 GB: 240 GB-h al mes');
  assert.equal(Math.round(m.gbhMes(15_000)), m.HOBBY.cupoGbh, 'a 15 s de media se agota el cupo');

  const holgado = m.veredicto({ ...SANO, turno_medio: { respuestas: 300, elapsed_ms: 400 } });
  assert.equal(holgado.sano, true);
  assert.ok(holgado.lineas.some((l) => l.nivel === 'ok' && /400 ms por turno.*unos 10 GB-h al mes de los 360/.test(l.texto)), JSON.stringify(holgado.lineas));

  const justo = m.veredicto({ ...SANO, turno_medio: { respuestas: 300, elapsed_ms: 12_000 } });
  assert.equal(justo.sano, true, 'es un aviso, no tumba el chequeo');
  assert.ok(justo.lineas.some((l) => l.nivel === 'aviso' && /288 GB-h.*pausa el proyecto entero.*opción A.*no comercial/.test(l.texto)), JSON.stringify(justo.lineas));

  // Sin la media larga, la de los últimos 5 min.
  assert.ok(m.veredicto(SANO).lineas.some((l) => /150 ms por turno/.test(l.texto)));
  assert.match(leer('cron-tick-estado.sql'), /'turno_medio'/);
});
