/**
 * VEN-10 · pulido r5 · un toque reclamado de un negocio que se gana antes
 * de enviarse no sale (0076). El disparador de 0076 cancela lo que está
 * en la cola al ganar, pero no toca lo reclamado (processing, a medio
 * enviar): eso lo decide la relectura antes de enviar (decideBeforeSend),
 * que mira el negocio igual que el reclamo. Postgres embebido con las
 * migraciones del repo, como mc_worker, con el canal falso y un reloj
 * falso. Sin red.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollContacts } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, motorKit } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, deps, touches, scalar } = motorKit({ db: () => db, motor: () => motor, prefix: '00000176', slug: 'motor-cerrado' });

/**
 * La base del motor, con una acción entre el reclamo y el envío: runDispatch
 * abre primero la transacción de los zombis, después la del reclamo y
 * después las del envío. `despuesDelReclamo` corre al terminar la segunda.
 */
function conPausaTrasElReclamo(despuesDelReclamo: () => Promise<void>): MotorDb {
  let n = 0;
  return {
    transaction: async (fn) => {
      const r = await motor.transaction(fn);
      n += 1;
      if (n === 2) await despuesDelReclamo();
      return r;
    },
  };
}

test('un toque reclamado de un negocio que se gana antes de enviarse se cancela con deal_won y no sale', async () => {
  const w = await workspace(1, { contacts: 1 });
  const [c] = w.contacts as [string];
  const deal = `${w.id.slice(0, 24)}0000000dea01`;
  await db.raw.exec(`
    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, amount, currency)
    VALUES ('${deal}', '${w.id}', '${w.company}', 'Serie de otoño', 'propuesta', 4000000, 'COP');
  `);
  const r = await motor.transaction((tx) =>
    enrollContacts(tx, { sequenceId: w.seq, contactIds: [c], dealId: deal, now: bogota('2026-09-23', '07:00') }));
  const enr = r.enrolled[0]!.enrollmentId;

  const fake = fakeChannels();
  const ganar = () => db.raw.query(`UPDATE deal SET stage_id = 'ganado', won_at = now() WHERE id = $1`, [deal]).then(() => undefined);
  const d = await runDispatch(conPausaTrasElReclamo(ganar), deps(w, fake, () => bogota('2026-09-23', '15:00')));

  assert.equal(d.claim.claimed, 1, 'el primer correo se reclamó antes de ganar');
  assert.equal(d.sent.length, 0);
  assert.equal(fake.email.sent.length, 0, 'nada llegó al proveedor');
  assert.deepEqual(d.canceled.map((x) => x.reason), ['deal_won']);
  const [primero, ...resto] = await touches(c);
  assert.deepEqual({ status: primero!.status, blocked_reason: primero!.blocked_reason }, { status: 'canceled', blocked_reason: 'deal_won' });
  // Lo que seguía en la cola lo canceló el disparador de 0076 al ganar.
  assert.deepEqual(resto.map((x) => [x.status, x.blocked_reason]), [['canceled', 'deal_won'], ['canceled', 'deal_won']]);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr]), 'completed');

  // Y la corrida siguiente no encuentra nada que reclamar.
  const d2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '15:00')));
  assert.equal(d2.claim.claimed, 0);
  assert.equal(fake.email.sent.length, 0);
});
