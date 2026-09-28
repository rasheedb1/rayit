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
import { updateContact } from '../src/queries/ventas.ts';
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

// ---------------------------------------------------------------------
// Pulido r3 · una baja del espacio no tumba el reclamo de los demás
// ---------------------------------------------------------------------
// El descarte del reclamo miraba la ficha y la lista global, pero no la
// del espacio (outbound_workspace_optout). La base sí la mira
// (enforce_outbound_optout, 0055 §8.3) y rechazaba el UPDATE en lote a
// 'processing': el reclamo entero abortaba en cada corrida, para TODOS
// los workspaces.

const WS_OTRO = randomUUID();
const WS_BAJA = randomUUID();
const CO_OTRO = randomUUID();
const CO_RARO = randomUUID();
const CO_BAJA = randomUUID();
const OTRA = randomUUID();
const RARA = randomUUID();
const ANA = randomUUID();
const LUIS = randomUUID();
const SEQ_BAJA = randomUUID();
const T_OTRA = randomUUID();
const T_RARA = randomUUID();
const T_ANA = randomUUID();
const T_LUIS = randomUUID();
const T_LUIS_BORRADOR = randomUUID();

/** Un workspace con su política encendida y su Gmail, como el de arriba. */
function espacio(ws: string, slug: string): string {
  return `
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${ws}', '${slug}', 'Reclamo ${slug}', 'America/Bogota');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_emails_per_day)
    VALUES ('${ws}', true, 'Calle 93 # 11-26, Bogotá', false, 100);
    INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
    VALUES ('enc:gmail:${slug}', '${ws}', '\\x00', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'));
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, display_name, status,
                                          daily_cap, weekly_cap, secret_ref)
    VALUES ('${ws}', 'email', 'gmail_oauth', '${slug}@gmail.test', 'Laura', 'connected', 100, 500, 'enc:gmail:${slug}');`;
}

const vencido = new Date(CLOCK.getTime() - 30_000).toISOString();
const sOtro = `otro-${WS_OTRO.slice(0, 8)}`;
const sBaja = `baja-${WS_BAJA.slice(0, 8)}`;

test('pulido r3 · siembra: dos workspaces con toques vencidos', async () => {
  await t.admin(`
    ${espacio(WS_OTRO, sOtro)}
    ${espacio(WS_BAJA, sBaja)}
    INSERT INTO company (id, name, owner_workspace_id) VALUES
      ('${CO_OTRO}', 'Fresko ${sOtro}', '${WS_OTRO}'),
      ('${CO_RARO}', 'Nutrivé ${sOtro}', '${WS_OTRO}'),
      ('${CO_BAJA}', 'Granos ${sBaja}', '${WS_BAJA}');
    INSERT INTO company_link (workspace_id, company_id) VALUES
      ('${WS_OTRO}', '${CO_OTRO}'), ('${WS_OTRO}', '${CO_RARO}'), ('${WS_BAJA}', '${CO_BAJA}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${OTRA}', '${CO_OTRO}', '${WS_OTRO}', 'Marta Gil', 'marta.${sOtro}@fresko.test', 'user_provided'),
      ('${RARA}', '${CO_RARO}', '${WS_OTRO}', 'Rosa Díaz', 'rosa.${sOtro}@nutrive.test', 'user_provided'),
      ('${ANA}', '${CO_BAJA}', '${WS_BAJA}', 'Ana Ríos', 'ana.${sBaja}@granos.test', 'user_provided'),
      ('${LUIS}', '${CO_BAJA}', '${WS_BAJA}', 'Luis Mora', 'luis.${sBaja}@granos.test', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ_BAJA}', '${WS_BAJA}', 'Granos', 'email', 'active');
    INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status) VALUES ('${WS_BAJA}', '${SEQ_BAJA}', '${LUIS}', 'active');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for) VALUES
      ('${T_OTRA}', '${WS_OTRO}', '${CO_OTRO}', '${OTRA}', 'email', 'Hola, Marta', 'Una idea.', 'scheduled', '${vencido}'),
      ('${T_RARA}', '${WS_OTRO}', '${CO_RARO}', '${RARA}', 'email', 'Hola, Rosa', 'Una idea.', 'scheduled', '${new Date(CLOCK.getTime() + 3_600_000).toISOString()}'),
      ('${T_ANA}', '${WS_BAJA}', '${CO_BAJA}', '${ANA}', 'email', 'Hola, Ana', 'Una idea.', 'scheduled', '${vencido}'),
      ('${T_LUIS}', '${WS_BAJA}', '${CO_BAJA}', '${LUIS}', 'email', 'Hola, Luis', 'Una idea.', 'scheduled', '${new Date(CLOCK.getTime() + 86_400_000).toISOString()}'),
      ('${T_LUIS_BORRADOR}', '${WS_BAJA}', '${CO_BAJA}', '${LUIS}', 'email', 'Luis, otra', 'Otra idea.', 'draft', NULL);
    -- La dirección de Ana ya está en la lista del espacio sin que su ficha
    -- diga nada (otra ficha se dio de baja con ella y después cambió de correo).
    INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash)
    VALUES ('${WS_BAJA}', 'ana.${sBaja}@granos.test', repeat('a', 64)),
           ('${WS_BAJA}', 'vieja.${sBaja}@granos.test', repeat('b', 64));
  `);
});

const estado = (id: string) =>
  t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; blocked_reason: string | null }>(`SELECT status, blocked_reason FROM outbound_touch WHERE id = $1`, [id])).rows[0],
  );

test('pulido r3 · cambiarle a una ficha el correo por uno de la lista del espacio cancela lo suyo y termina su cadencia', async () => {
  await t.db.withWorkspace(WS_BAJA, (tx) => updateContact(tx, LUIS, { email: `vieja.${sBaja}@granos.test` }));
  assert.deepEqual({ ...(await estado(T_LUIS)) }, { status: 'canceled', blocked_reason: 'opted_out' });
  assert.deepEqual({ ...(await estado(T_LUIS_BORRADOR)) }, { status: 'canceled', blocked_reason: 'opted_out' });
  const e = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE contact_id = $1`, [LUIS])).rows[0],
  );
  assert.equal(e?.status, 'opted_out');
});

test('pulido r3 · una baja del espacio se cancela y el toque del otro workspace sale igual', async (ctx) => {
  if (t.kind === 'postgres') {
    ctx.skip('el reclamo sin workspace tomaría los toques de la demo que trae sembrada la copia de TEST_DATABASE_URL');
    return;
  }
  // Sin filtro de workspace: el reclamo del cron, de todos a la vez.
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'] }));
  assert.deepEqual(r.claimed.map((x) => x.id), [T_OTRA], 'el toque del otro workspace sale');
  assert.equal(r.canceledOptedOut, 1);
  assert.deepEqual({ ...(await estado(T_ANA)) }, { status: 'canceled', blocked_reason: 'opted_out' });
});

test('pulido r3 · si la base rechaza un toque del lote, los demás se reclaman igual', async (ctx) => {
  if (t.kind === 'postgres') {
    ctx.skip('sigue a la prueba de arriba, que se salta contra Postgres real (la demo sembrada)');
    return;
  }
  // Una regla que el descarte no conoce: la base rechaza el reclamo de Rosa con check_violation.
  const later = new Date(CLOCK.getTime() + 2 * 3_600_000);
  const otro = randomUUID();
  await t.admin(`
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for)
    VALUES ('${otro}', '${WS_OTRO}', '${CO_OTRO}', '${OTRA}', 'email', 'Marta, otra', 'Otra idea.', 'scheduled', '${later.toISOString()}');
    UPDATE outbound_policy SET min_days_between_touches = 0 WHERE workspace_id = '${WS_OTRO}';
    CREATE FUNCTION prueba_rechaza_rosa() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '${T_RARA}' AND NEW.status = 'processing' THEN
        RAISE EXCEPTION 'regla de prueba' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER prueba_rechaza_rosa BEFORE UPDATE ON outbound_touch FOR EACH ROW EXECUTE FUNCTION prueba_rechaza_rosa();
  `);
  try {
    const r = await t.db.asWorker((tx) =>
      claimDueTouches(tx, { now: new Date(later.getTime() + 60_000), channels: ['email'], workspaceId: WS_OTRO }),
    );
    assert.deepEqual(r.claimed.map((x) => x.id), [otro], 'el otro toque del lote sale');
    assert.deepEqual({ ...(await estado(T_RARA)) }, { status: 'failed', blocked_reason: 'claim_rejected' });
    const avisos = await t.db.asWorker(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE entity_id = $1 AND kind = 'outreach_failed'`, [T_RARA])).rows[0],
    );
    assert.equal(avisos?.n, 1, 'con aviso: no desaparece en silencio');
  } finally {
    await t.admin(`DROP TRIGGER prueba_rechaza_rosa ON outbound_touch; DROP FUNCTION prueba_rechaza_rosa();`);
  }
});
