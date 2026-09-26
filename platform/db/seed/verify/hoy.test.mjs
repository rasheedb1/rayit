/**
 * Las dos acciones «de hoy» del seed 0002 nacen de hoy a cualquier hora.
 *
 * verify/0002.sql (i3) exige dos seguimientos para hoy, y deal_pipeline
 * decide «hoy» o «vencido» con su propio now() en la zona del espacio.
 * Si el seed pone la fecha de hoy a una hora que ya pasó, nacen vencidas
 * y la puerta de calidad sale roja según la hora a la que se corra (con
 * el tope de las 23:30, entre las 23:30 y la medianoche de Bogotá).
 *
 * Aquí se toma el CTE `hoy` del seed tal cual, se le cambia now() por un
 * instante fijo y se evalúa en PGlite a varias horas del día local: el
 * vencimiento tiene que ser posterior a ese instante y del mismo día en
 * Bogotá. No siembra nada ni depende del reloj de la máquina.
 *
 *   node --test db/seed/verify/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const seed = readFileSync(new URL('../0002_demo_ventas_metricas.sql', import.meta.url), 'utf8');

/** El cuerpo del CTE `hoy` de la sentencia de deal: desde «hoy AS (» hasta su paréntesis de cierre. */
function cteHoy(sql) {
  const ini = sql.indexOf('hoy AS (');
  assert.ok(ini >= 0, 'el seed 0002 tiene el CTE hoy');
  let prof = 0;
  for (let i = ini + 'hoy AS '.length; i < sql.length; i++) {
    if (sql[i] === '(') prof += 1;
    else if (sql[i] === ')') {
      prof -= 1;
      if (prof === 0) return sql.slice(ini + 'hoy AS '.length, i + 1);
    }
  }
  throw new Error('el CTE hoy no cierra');
}

const cuerpo = cteHoy(seed).replace(/\bnow\s*\(\s*\)/g, '$1::timestamptz');

/** Horas locales de Bogotá (UTC−5, sin horario de verano) a las que se puede sembrar. */
const HORAS = ['00:05', '08:00', '14:59', '15:00', '15:01', '22:10', '23:10', '23:30', '23:36', '23:59'];

test('a cualquier hora del día en Bogotá, el vencimiento de «hoy» es de hoy y todavía no pasó', async () => {
  const db = new PGlite();
  try {
    for (const hora of HORAS) {
      const instante = `2026-09-23 ${hora}:00-05`;
      const { rows } = await db.query(
        `WITH hoy AS ${cuerpo}
         SELECT vence > $1::timestamptz AS futuro,
                (vence AT TIME ZONE 'America/Bogota')::date = ($1::timestamptz AT TIME ZONE 'America/Bogota')::date AS mismo_dia,
                to_char(vence AT TIME ZONE 'America/Bogota', 'HH24:MI:SS') AS local
           FROM hoy`,
        [instante],
      );
      const r = rows[0];
      assert.equal(r.futuro, true, `a las ${hora} vence a las ${r.local}: ya pasó`);
      assert.equal(r.mismo_dia, true, `a las ${hora} vence a las ${r.local}: no es de hoy`);
    }
  } finally {
    await db.close();
  }
});
