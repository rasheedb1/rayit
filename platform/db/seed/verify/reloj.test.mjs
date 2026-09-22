/**
 * El reloj del harness sostiene toda la evidencia de que la demo no
 * caduca: si desplaza mal, las cuatro pasadas pasan midiendo otra cosa.
 * Por eso se prueba solo, sin base de datos.
 *
 *   node --test db/seed/verify/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desplazarReloj, trozos } from './reloj.mjs';

const leer = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');

test('sin días que desplazar devuelve el original intacto', () => {
  const sql = "SELECT CURRENT_DATE, now();";
  assert.equal(desplazarReloj(sql, 0), sql);
});

test('el código sí se desplaza', () => {
  assert.equal(
    desplazarReloj('SELECT CURRENT_DATE - 3, now() - interval \'2 hours\';', 40),
    "SELECT (CURRENT_DATE + 40) - 3, (now() + interval '40 days') - interval '2 hours';"
  );
});

test('un literal que se parece al reloj no se toca: falla en voz alta', () => {
  assert.throws(
    () => desplazarReloj("INSERT INTO t (nota) VALUES ('se corre con now() cada noche');", 40),
    /DENTRO de un literal/
  );
  assert.throws(
    () => desplazarReloj("SELECT 'vence el CURRENT_DATE'::text;", 40),
    /CURRENT_DATE/
  );
});

test('las comillas dobladas no cortan el literal antes de tiempo', () => {
  // 'no''se toca now()' es UN literal, no dos.
  assert.throws(() => desplazarReloj("SELECT 'no''se toca now()';", 40), /DENTRO de un literal/);
  assert.equal(desplazarReloj("SELECT 'a''b', CURRENT_DATE;", 7), "SELECT 'a''b', (CURRENT_DATE + 7);");
});

test('los comentarios nombran el reloj sin que eso cambie nada', () => {
  const sql = '-- todo lo relativo va contra CURRENT_DATE\nSELECT CURRENT_DATE;';
  assert.equal(desplazarReloj(sql, 1), '-- todo lo relativo va contra CURRENT_DATE\nSELECT (CURRENT_DATE + 1);');
  const bloque = '/* now() aquí es prosa */ SELECT now();';
  assert.equal(desplazarReloj(bloque, 2), "/* now() aquí es prosa */ SELECT (now() + interval '2 days');");
});

test('dentro de un bloque $$ el código se desplaza y el literal sigue protegido', () => {
  const sql = 'DO $$ BEGIN PERFORM now(); END $$;';
  assert.equal(desplazarReloj(sql, 5), "DO $$ BEGIN PERFORM (now() + interval '5 days'); END $$;");
  assert.throws(() => desplazarReloj("DO $$ BEGIN RAISE NOTICE 'now()'; END $$;", 5), /DENTRO de un literal/);
});

test('partir y volver a juntar devuelve el texto original', () => {
  for (const ruta of ['../0002_demo_ventas_metricas.sql', './0002.sql']) {
    const sql = leer(ruta);
    assert.equal(trozos(sql).map((t) => t.texto).join(''), sql, ruta);
  }
});

test('los seeds y los verify que se despliegan hoy se pueden desplazar', () => {
  for (const ruta of [
    '../0001_catalog.sql',
    '../0002_demo_ventas_metricas.sql',
    '../0003_demo_finanzas_campanas.sql',
    './0002.sql',
    './0003.sql',
  ]) {
    assert.doesNotThrow(() => desplazarReloj(leer(ruta), 40, ruta), ruta);
  }
});
