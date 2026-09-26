/**
 * VEN-12 · pulido r1 · reservar el tope diario del modelo antes de
 * llamarlo (0072).
 *
 * outbound.generate y outbound.review pueden correr a la vez en el mismo
 * espacio. Antes, los dos miraban el saldo, los dos pasaban con el mismo
 * dinero y el tope se superaba hasta en una llamada por job. Ahora
 * comprobar y apartar son una sola transacción con candado por espacio:
 * con saldo para una sola llamada, la segunda reserva no pasa.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  llmBudgetLeftUsd, LLM_RESERVATION_TTL_MIN, recordOutreachLlmCall, releaseLlmReservation, reserveLlmBudget,
} from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  // Un tope de 1 USD y nada gastado hoy: el punto de partida de cada prueba.
  await t.admin(`UPDATE outbound_policy SET llm_daily_cap_usd = 1 WHERE workspace_id = '${WORKSPACE_LAURA}'`);
  await t.admin(`DELETE FROM outbound_llm_call WHERE workspace_id = '${WORKSPACE_LAURA}'`);
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

const reservar = (estimateUsd: number, purpose: 'generate' | 'judge' = 'generate') =>
  t.db.asWorker((tx) => reserveLlmBudget(tx, { workspaceId: WORKSPACE_LAURA, purpose, estimateUsd }));
const saldo = () => t.db.asWorker((tx) => llmBudgetLeftUsd(tx, WORKSPACE_LAURA));

test('con saldo para una sola llamada, dos reservas a la vez: pasa una y la otra no', async () => {
  const [a, b] = await Promise.all([reservar(0.6), reservar(0.6, 'judge')]);
  assert.equal([a, b].filter(Boolean).length, 1, JSON.stringify([a, b]));
  const id = (a ?? b)!;
  // Lo apartado cuenta como gastado mientras la llamada está en curso.
  assert.ok(Math.abs((await saldo()) - 0.4) < 1e-9);
  // Registrar la llamada de verdad suelta su reserva en la misma transacción: se cuenta una vez, con su costo real.
  await t.db.asWorker((tx) =>
    recordOutreachLlmCall(tx, {
      workspaceId: WORKSPACE_LAURA, touchId: null, purpose: 'generate', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 100,
      costUsd: 0.25, reservationId: id,
    }),
  );
  const abiertas = await t.db.asWorker((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_llm_reservation`));
  assert.equal(abiertas.rows[0]!.n, 0);
  assert.ok(Math.abs((await saldo()) - 0.75) < 1e-9);
});

test('soltar una reserva devuelve lo apartado; una que nadie soltó deja de contar a los diez minutos', async () => {
  const id = await reservar(0.5);
  assert.ok(id);
  await t.db.asWorker((tx) => releaseLlmReservation(tx, id!));
  assert.ok(Math.abs((await saldo()) - 0.75) < 1e-9);
  // Un worker que murió a media llamada: su reserva envejece y ya no aparta.
  const huerfana = await reservar(0.5);
  assert.ok(huerfana);
  assert.ok(Math.abs((await saldo()) - 0.25) < 1e-9);
  await t.admin(
    `UPDATE outbound_llm_reservation SET created_at = now() - make_interval(mins => ${LLM_RESERVATION_TTL_MIN + 1}) WHERE id = '${huerfana}'`,
  );
  assert.ok(Math.abs((await saldo()) - 0.75) < 1e-9);
});

test('la web no escribe reservas: mc_app solo las lee, las de su espacio', async () => {
  await assert.rejects(
    t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      tx.query(`INSERT INTO outbound_llm_reservation (workspace_id, purpose, amount) VALUES ($1::uuid, 'generate', 0)`, [WORKSPACE_LAURA]),
    ),
  );
  const leidas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query('SELECT id FROM outbound_llm_reservation'));
  assert.ok(Array.isArray(leidas.rows));
});
