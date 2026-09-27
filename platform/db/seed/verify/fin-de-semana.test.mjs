/**
 * La verificación de los seeds, con el reloj en sábado y en domingo.
 *
 * `pnpm verificar` salía en rojo cada fin de semana: el seed 0006 ponía
 * sus correos «de hoy» en la fecha del reloj, sin mirar si era día hábil,
 * y verify/0009 (c) exige que ningún contador diario caiga en sábado o
 * domingo. Lo que la corrida normal de `pnpm test` solo ve el día que se
 * corre, aquí se ve siempre: run.mjs con `--dias N` hasta el próximo
 * sábado y hasta el próximo domingo en la zona de la demo (Bogotá), las
 * dos a la vez.
 *
 * Con --dias, run.mjs tolera solo las comprobaciones que miran el now()
 * interno de una vista (TOLERADAS_CON_DIAS, y dice cuáles); los
 * contadores de verify/0009 (c) y los envíos de verify/0006 (e) no están
 * entre ellas.
 *
 *   node --test db/seed/verify/
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url));
const ZONA_DEMO = 'America/Bogota';

/** Día ISO de la semana (1 = lunes … 7 = domingo) de hoy en la zona de la demo. */
function isodowHoy() {
  const corto = new Intl.DateTimeFormat('en-US', { timeZone: ZONA_DEMO, weekday: 'short' }).format(new Date());
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(corto) + 1;
}

/** Días hasta el próximo `isodow` (1..7: nunca 0, para no repetir la corrida normal). */
export function diasHasta(isodow, hoy = isodowHoy()) {
  return ((isodow - hoy + 6) % 7) + 1;
}

function correr(dias) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [RUN, '--dias', String(dias)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('close', (code) => resolve({ code, salida }));
  });
}

test('diasHasta cuenta hasta el próximo, nunca cero', () => {
  assert.equal(diasHasta(6, 7), 6); // de domingo al sábado
  assert.equal(diasHasta(7, 7), 7); // de domingo al domingo siguiente
  assert.equal(diasHasta(6, 5), 1); // de viernes al sábado
  assert.equal(diasHasta(7, 1), 6); // de lunes al domingo
});

// Las dos corridas a la vez: cada una levanta su propia base embebida.
describe('el fin de semana no deja la puerta en rojo', { concurrency: true }, () => {
  for (const [nombre, isodow] of [['sábado', 6], ['domingo', 7]]) {
    test(`los seeds verifican en verde con el reloj en ${nombre}`, { timeout: 300_000 }, async () => {
      const dias = diasHasta(isodow);
      const { code, salida } = await correr(dias);
      const fallos = salida.split('\n').filter((l) => l.includes('✗')).join('\n');
      assert.equal(code, 0, `run.mjs --dias ${dias} (${nombre}) salió con ${code}:\n${fallos || salida.slice(-2000)}`);
    });
  }
});
