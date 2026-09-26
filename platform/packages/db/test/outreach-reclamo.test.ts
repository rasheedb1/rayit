/**
 * VEN-10 · dos reclamos a la vez (el cron y un job:dispatch a mano, o dos
 * procesos) no le mandan dos mensajes a la misma marca el mismo día.
 *
 * FOR UPDATE SKIP LOCKED solo bloquea los toques: dos reclamos toman
 * toques DISTINTOS de la misma marca, y la separación con la marca
 * (min_days_between_touches) y el ritmo de la cuenta se leen de lo ya
 * confirmado. Sin el candado del reclamo (CLAIM_LOCK_KEY), el segundo no
 * veía el reclamo del primero, todavía sin confirmar, y reclamaba también.
 *
 *   · en PGlite (las transacciones van en serie): el candado se toma y la
 *     regla se cumple en serie;
 *   · con TEST_DATABASE_URL (el Postgres 16 del CI, paso
 *     «contra-postgres-real»): el segundo reclamo ESPERA al primero y
 *     después ve su toque, así que el suyo se pospone (company_gap).
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerSql } from '../src/client.ts';
import { CLAIM_LOCK_KEY, claimDueTouches, type ClaimReport } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

/** Ids nuevos en cada corrida: contra un Postgres que se queda, la prueba se puede repetir. */
const WS = randomUUID();
const CO = randomUUID();
const SOFIA = randomUUID();
const PEDRO = randomUUID();
const GMAIL = randomUUID();
const T_SOFIA = randomUUID();
const T_PEDRO = randomUUID();
/** Un miércoles a mediodía en Bogotá: dentro de la ventana laboral. */
const CLOCK = new Date('2026-09-23T12:00:00-05:00');

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  const slug = `reclamo-${WS.slice(0, 8)}`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', '${slug}', 'Reclamo', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Vitalé', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${CO}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${SOFIA}', '${CO}', '${WS}', 'Sofía Cárdenas', 'sofia.${slug}@vitale.test', 'user_provided'),
      ('${PEDRO}', '${CO}', '${WS}', 'Pedro Ruiz', 'pedro.${slug}@vitale.test', 'user_provided');
    -- Tres días entre mensajes a la misma marca: el segundo reclamo tiene que ver el primero.
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_touches_per_company, min_days_between_touches)
    VALUES ('${WS}', true, 'Calle 93 # 11-26, Bogotá', false, 10, 3);
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:${slug}', '${WS}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status,
                                          daily_cap, weekly_cap, secret_ref)
    VALUES ('${GMAIL}', '${WS}', 'email', 'gmail_oauth', '${slug}@gmail.test', 'Laura', 'connected', 40, 200, 'enc:gmail:${slug}');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for) VALUES
      ('${T_SOFIA}', '${WS}', '${CO}', '${SOFIA}', 'email', 'Hola, Sofía', 'Una idea para Vitalé.', 'scheduled', '${new Date(CLOCK.getTime() - 120_000).toISOString()}'),
      ('${T_PEDRO}', '${WS}', '${CO}', '${PEDRO}', 'email', 'Hola, Pedro', 'Una idea para Vitalé.', 'scheduled', '${new Date(CLOCK.getTime() - 60_000).toISOString()}');
  `);
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

/** Un reclamo de UN toque: así dos reclamos a la vez toman toques distintos de la misma marca. */
const reclamo = (tx: WorkerSql) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: WS, limit: 1 });

test('dos reclamos a la vez: uno sale y el otro se pospone por la separación con la marca', async () => {
  let a: ClaimReport;
  let b: ClaimReport;
  if (t.kind !== 'postgres') {
    // PGlite serializa: se comprueba que el reclamo toma el candado y la regla en serie.
    a = await t.db.asWorker(async (tx) => {
      const r = await reclamo(tx);
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
            AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
        [CLAIM_LOCK_KEY],
      );
      assert.equal(rows[0]?.n, 1, 'el reclamo toma el candado de la transacción');
      return r;
    });
    b = await t.db.asWorker(reclamo);
  } else {
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    let reclamada!: () => void;
    const primeraReclamo = new Promise<void>((r) => (reclamada = r));
    const primera = t.db.asWorker(async (tx) => {
      const r = await reclamo(tx);
      reclamada();
      await puerta;
      return r;
    });
    await primeraReclamo;
    let resuelta = false;
    const segunda = t.db.asWorker(reclamo).then((r) => ((resuelta = true), r));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(resuelta, false, 'el segundo reclamo espera al primero en el candado');
    soltar();
    [a, b] = [await primera, await segunda];
  }
  assert.deepEqual(a.claimed.map((x) => x.id), [T_SOFIA], 'el primero toma el más antiguo');
  assert.deepEqual(b.claimed, [], 'el segundo no manda otro mensaje a Vitalé el mismo día');
  assert.deepEqual(b.paced.map((x) => [x.touchId, x.reason]), [[T_PEDRO, 'company_gap']]);
  const pedro = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; attempt_count: number }>(`SELECT status, attempt_count FROM outbound_touch WHERE id = $1`, [T_PEDRO])).rows[0],
  );
  assert.deepEqual({ ...pedro }, { status: 'scheduled', attempt_count: 0 }, 'pospuesto, sin gastar un intento');
});

test('outbound.dispatch declara una sola corrida a la vez (0060)', async () => {
  const fila = await t.db.asWorker(async (tx) =>
    (await tx.query<{ max_concurrency: number }>(`SELECT max_concurrency FROM job_definition WHERE id = 'outbound.dispatch'`)).rows[0],
  );
  assert.equal(fila?.max_concurrency, 1);
});
