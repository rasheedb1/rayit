/**
 * Los cuatro correos de la demo (seed 0006) salen el último día hábil,
 * dentro de la ventana de envío y en la zona del espacio (pulido r3).
 *
 * Antes salían «hace 3 a 9 horas» del reloj de quien sembraba: sembrada
 * un domingo, la demo enviaba en domingo y verify/0009 (c) salía en rojo
 * cada fin de semana. Aquí se toma del seed, tal cual, la parte que
 * decide las horas (las CTE ws, ancla, correos y x), se le cambia now()
 * por un instante fijo y se evalúa en PGlite a varias horas de varios
 * días, con la ventana de la demo, con otra zona y otra ventana, y sin
 * política. No siembra nada ni depende del reloj de la máquina.
 *
 *   node --test db/seed/verify/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const seed = readFileSync(new URL('../0006_demo_entregabilidad.sql', import.meta.url), 'utf8');

/** Las CTE de las horas: desde «WITH ws AS (» hasta el INSERT que las usa. */
function ctes(sql) {
  const ini = sql.indexOf('WITH ws AS (');
  assert.ok(ini >= 0, 'el seed 0006 tiene la CTE ws');
  const fin = sql.indexOf('\nINSERT INTO outbound_touch', ini);
  assert.ok(fin > ini, 'las CTE de 0006 terminan en el INSERT de outbound_touch');
  return sql.slice(ini, fin);
}

const WITH = ctes(seed).replace(/\bnow\s*\(\s*\)/g, '$1::timestamptz');
const WS = '00000002-0000-4000-8000-000000000001';
const NATALIA = '00000006-0000-4000-8000-000000070001';

async function base({ tz, ventana }) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE workspace (id uuid PRIMARY KEY, timezone text NOT NULL);
    CREATE TABLE outbound_policy (workspace_id uuid PRIMARY KEY, send_window_start time, send_window_end time);
    INSERT INTO workspace VALUES ('${WS}', '${tz}');
  `);
  if (ventana) {
    await db.query('INSERT INTO outbound_policy VALUES ($1, $2, $3)', [WS, ventana[0], ventana[1]]);
  }
  return db;
}

/** Evalúa las horas del seed en `instante` y comprueba lo que vale siempre. */
async function horas(db, instante, { tz, ventana = ['09:00', '17:00'] }) {
  const { rows } = await db.query(
    `${WITH}
     SELECT x.id::text AS id,
            (x.enviado AT TIME ZONE $2)::date::text AS dia,
            to_char(x.enviado AT TIME ZONE $2, 'HH24:MI') AS hora,
            extract(isodow FROM x.enviado AT TIME ZONE $2)::int AS isodow,
            x.enviado <= $1::timestamptz AS pasado,
            x.enviado + interval '20 minutes' <= $1::timestamptz AS rebote_leido
       FROM x ORDER BY x.enviado`,
    [instante, tz],
  );
  assert.equal(rows.length, 4, `${instante}: los cuatro correos tienen hora`);
  assert.equal(new Set(rows.map((r) => r.dia)).size, 1, `${instante}: los cuatro salen el mismo día`);
  for (const r of rows) {
    assert.ok(r.isodow < 6, `${instante}: ${r.id} sale en fin de semana (${r.dia})`);
    assert.ok(r.hora >= ventana[0] && r.hora <= ventana[1], `${instante}: ${r.hora} está fuera de la ventana`);
    assert.equal(r.pasado, true, `${instante}: ${r.id} sale en el futuro (${r.dia} ${r.hora})`);
  }
  assert.equal(rows.find((r) => r.id === NATALIA).rebote_leido, true, `${instante}: el rebote de Natalia no ha llegado`);
  return rows;
}

test('con la ventana de la demo (Bogotá, 09:00–17:00), el último día hábil en que ya salieron', async () => {
  const opciones = { tz: 'America/Bogota', ventana: ['09:00', '17:00'] };
  const db = await base(opciones);
  // [instante local, día esperado]: sábado, domingo, lunes temprano, el
  // lunes justo antes y justo después de que salga el último más media
  // hora (15:24 + 30), el martes de madrugada y el viernes al cierre.
  const casos = [
    ['2026-09-26 12:00', '2026-09-25'],
    ['2026-09-27 23:59', '2026-09-25'],
    ['2026-09-28 00:05', '2026-09-25'],
    ['2026-09-28 08:00', '2026-09-25'],
    ['2026-09-28 15:53', '2026-09-25'],
    ['2026-09-28 15:54', '2026-09-28'],
    ['2026-09-28 16:30', '2026-09-28'],
    ['2026-09-29 00:05', '2026-09-28'],
    ['2026-10-02 17:30', '2026-10-02'],
    ['2026-10-03 09:00', '2026-10-02'],
  ];
  try {
    for (const [local, esperado] of casos) {
      const rows = await horas(db, `${local}:00-05`, opciones);
      assert.equal(rows[0].dia, esperado, `a las ${local} de Bogotá salen el ${rows[0].dia}`);
    }
    const rows = await horas(db, '2026-09-28 16:30:00-05', opciones);
    assert.deepEqual(rows.map((r) => r.hora), ['09:48', '11:48', '13:24', '15:24']);
  } finally {
    await db.close();
  }
});

test('la zona y la ventana salen del espacio, no de Colombia', async () => {
  const opciones = { tz: 'Europe/Madrid', ventana: ['08:00', '12:00'] };
  const db = await base(opciones);
  try {
    // El último sale a las 11:12 de Madrid; con la media hora, a las 11:42 ya cuenta el lunes.
    assert.equal((await horas(db, '2026-09-26 10:00:00+02', opciones))[0].dia, '2026-09-25');
    assert.equal((await horas(db, '2026-09-28 11:41:00+02', opciones))[0].dia, '2026-09-25');
    const lunes = await horas(db, '2026-09-28 11:42:00+02', opciones);
    assert.equal(lunes[0].dia, '2026-09-28');
    assert.deepEqual(lunes.map((r) => r.hora), ['08:24', '09:24', '10:12', '11:12']);
  } finally {
    await db.close();
  }
});

test('sin política de envío, la ventana por omisión (09:00–17:00)', async () => {
  const opciones = { tz: 'America/Bogota', ventana: null };
  const db = await base(opciones);
  try {
    const rows = await horas(db, '2026-09-27 10:00:00-05', { ...opciones, ventana: ['09:00', '17:00'] });
    assert.equal(rows[0].dia, '2026-09-25');
  } finally {
    await db.close();
  }
});
