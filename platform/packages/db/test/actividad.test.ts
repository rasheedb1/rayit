/**
 * VEN-16 · actividad y métricas del outreach, con la RLS de la web:
 *
 *   · una semana de envíos de prueba (una cadencia de tres pasos, ocho
 *     personas, toques en los ocho estados, respuestas clasificadas): el
 *     embudo de outbound_funnel_by_step cuadra con outbound_touch fila a
 *     fila, y además con la tabla escrita a mano;
 *   · otro workspace no ve nada de esto;
 *   · la cola enseña el fallido con su motivo, y reintentarlo lo devuelve
 *     a scheduled (y reabre la cadencia que se completó por él); lo que un
 *     reintento no arregla (rebote, zombi, un paso posterior ya enviado)
 *     no vuelve;
 *   · cancelar en masa cancela lo cancelable y avanza la cadencia;
 *   · el uso por canal: el límite duro pasa por la curva de calentamiento
 *     de @mc/core, el día del calentamiento de la vista es el de warmupDay,
 *     y el semáforo dice ok, near o full;
 *   · la salud de la secuencia cuadra con el embudo.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { warmupDailyLimit, warmupDay } from '@mc/core/outreach/warmup';
import {
  cancelQueuedTouches, getQueueFacets, getSequenceHealth, listChannelUsage, listFunnelByStep, listOutboundQueue,
  listSequenceHealth, QUEUE_BUCKET_STATUSES, retryFailedTouches, usageLevel,
} from '../src/queries/actividad.ts';
import { TOUCH_STATUSES } from '../src/schema/ventas.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const id = (kind: string) => `00000064-0000-4000-8000-${kind.padStart(12, '0')}`;
const WS_A = id('a');
const WS_B = id('b');
const CO = id('c0');
const CO_B = id('c0b');
const SEQ = id('5e');
const SEQ_B = id('5eb');
const STEP = { s1: id('5e01'), s2: id('5e02'), s3: id('5e03'), b1: id('5eb1') };
const ACC = { email: id('ac01'), linkedin: id('ac02') };
const TZ = 'America/Bogota';
/** Las ocho personas de la cadencia: c1 … c8. */
const PEOPLE = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const contact = (n: number) => id(`d${n}`);
const enrollment = (n: number) => id(`e${n}`);
const touch = (n: number, step: 1 | 2 | 3) => id(`7${n}${step}`);

type Status = (typeof TOUCH_STATUSES)[number];
interface Fixture {
  status: Status;
  /** Días atrás del envío (o del cambio de estado). */
  ago: number;
  opened?: boolean;
  replied?: boolean;
  /** Las intenciones de las respuestas entrantes a ese toque. */
  intents?: string[];
  reason?: string;
}

/**
 * La semana de envíos. Una fila por persona, una columna por paso (correo
 * el día 0, respuesta en el hilo el día 2, LinkedIn el día 4).
 */
const WEEK: Record<(typeof PEOPLE)[number], [Fixture, Fixture, Fixture]> = {
  1: [{ status: 'sent', ago: 7, opened: true, replied: true, intents: ['interested'] },
      { status: 'canceled', ago: 6, reason: 'replied' }, { status: 'canceled', ago: 6, reason: 'replied' }],
  2: [{ status: 'sent', ago: 7, opened: true },
      { status: 'sent', ago: 5, opened: true, replied: true, intents: ['not_now'] }, { status: 'canceled', ago: 4, reason: 'replied' }],
  3: [{ status: 'sent', ago: 6 }, { status: 'sent', ago: 4, opened: true }, { status: 'failed', ago: 2, reason: 'max_attempts' }],
  4: [{ status: 'sent', ago: 6, opened: true, replied: true, intents: ['interested', 'interested'] },
      { status: 'canceled', ago: 5, reason: 'replied' }, { status: 'canceled', ago: 5, reason: 'replied' }],
  5: [{ status: 'failed', ago: 5, reason: 'bounced' }, { status: 'skipped', ago: 5, reason: 'email_invalid' },
      { status: 'scheduled', ago: 1 }],
  6: [{ status: 'sent', ago: 3 }, { status: 'held', ago: 1, reason: 'needs_review' }, { status: 'draft', ago: 1 }],
  7: [{ status: 'failed', ago: 2, reason: 'zombie' }, { status: 'processing', ago: 0 }, { status: 'draft', ago: 0 }],
  8: [{ status: 'failed', ago: 4, reason: 'rejected' }, { status: 'sent', ago: 2, replied: true, intents: ['ooo', 'interested'] },
      { status: 'scheduled', ago: 0 }],
};

/** El embudo esperado, escrito a mano a partir de WEEK (paso → enviados, abiertos, respondidos, positivos, pendientes, fallidos, detenidos). */
const EXPECTED = [
  { position: 1, sent: 5, opened: 3, replied: 2, positive: 2, pending: 0, failed: 3, stopped: 0 },
  { position: 2, sent: 3, opened: 2, replied: 2, positive: 1, pending: 2, failed: 0, stopped: 3 },
  { position: 3, sent: 0, opened: 0, replied: 0, positive: 0, pending: 4, failed: 1, stopped: 3 },
];

let t: TestDb;
const q = (s: string | null | undefined) => (s === null || s === undefined ? 'NULL' : `'${s.replace(/'/g, "''")}'`);
const ts = (ago: number) => `now() - interval '${ago} days'`;

function touchSql(n: number, step: 1 | 2 | 3, f: Fixture): string {
  const stepId = [STEP.s1, STEP.s2, STEP.s3][step - 1]!;
  const channel = step === 3 ? 'linkedin' : 'email';
  const sent = f.status === 'sent';
  const started = sent || f.status === 'failed' || f.status === 'processing';
  const recipient = started ? (channel === 'email' ? `c${n}@marca.test` : `li-c${n}`) : null;
  return `('${touch(n, step)}', '${WS_A}', '${CO}', '${contact(n)}', '${SEQ}', ${step}, '${enrollment(n)}', '${stepId}', '${channel}',
    ${channel === 'email' ? q(`Paso ${step} para c${n}`) : 'NULL'}, 'Hola, c${n}.', '${f.status}', ${ts(f.ago)},
    ${sent ? ts(f.ago) : 'NULL'}, ${started ? 1 : 0}, ${q(recipient)}, ${sent ? q(`prov-${n}-${step}`) : 'NULL'},
    ${sent && f.opened ? `${ts(f.ago)} + interval '2 hours'` : 'NULL'}, ${sent && f.replied ? `${ts(f.ago)} + interval '5 hours'` : 'NULL'},
    ${f.status === 'held' ? q(f.reason) : 'NULL'}, ${f.status !== 'held' ? q(f.reason) : 'NULL'},
    ${f.status === 'processing' ? 'now()' : 'NULL'}, ${ts(f.ago)}, ${started ? `'${ACC[channel]}'` : 'NULL'})`;
}

/** El estado de cada cadencia después de su semana. */
const ENROLLMENT_STATUS: Record<(typeof PEOPLE)[number], string> = {
  1: 'replied', 2: 'replied', 3: 'completed', 4: 'replied', 5: 'active', 6: 'active', 7: 'active', 8: 'active',
};

before(async () => {
  t = await openTestDb({ seeds: false });
  const today = `(now() AT TIME ZONE '${TZ}')::date`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_A}', 'actividad-a', 'Actividad A', '${TZ}'),
                                                          ('${WS_B}', 'actividad-b', 'Actividad B', '${TZ}');
    INSERT INTO outbound_policy (workspace_id, postal_address, max_emails_per_day, warmup_days)
    VALUES ('${WS_A}', 'Calle 93 # 11-26, Bogotá', 80, 14);
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap,
                                          weekly_cap, warmup_started_at, last_ok_at)
    VALUES ('${ACC.email}', '${WS_A}', 'email', 'gmail_oauth', 'laura@marca-a.test', 'laura@marca-a.test', 'connected', 50, 200,
            now() - interval '3 days', now()),
           ('${ACC.linkedin}', '${WS_A}', 'linkedin', 'unipile', 'unipile-actividad-a', 'Laura Méndez', 'connected', 25, 100,
            NULL, now());
    INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count) VALUES
      ('${WS_A}', '${ACC.email}', 'day', ${today}, 'email', 17),
      ('${WS_A}', '${ACC.email}', 'day', ${today} - 3, 'email', 9),
      ('${WS_A}', '${ACC.linkedin}', 'day', ${today}, 'linkedin', 25),
      ('${WS_A}', NULL, 'day', ${today}, 'email', 17);
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Marca A', '${WS_A}'), ('${CO_B}', 'Marca B', '${WS_B}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${CO}'), ('${WS_B}', '${CO_B}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, linkedin_url, source) VALUES
      ${PEOPLE.map((n) => `('${contact(n)}', '${CO}', '${WS_A}', 'Persona ${n}', 'c${n}@marca.test', 'https://www.linkedin.com/in/c${n}', 'user_provided')`).join(',\n')},
      ('${contact(9)}', '${CO_B}', '${WS_B}', 'Persona de B', 'b@marca-b.test', NULL, 'user_provided');
    UPDATE contact SET email_invalid = true, email_invalid_at = now() - interval '5 days', email_invalid_reason = 'bounced'
     WHERE id = '${contact(5)}';
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES
      ('${SEQ}', '${WS_A}', 'Semana de prueba', 'email', 'active'), ('${SEQ_B}', '${WS_B}', 'La de B', 'email', 'active');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, body_template)
    VALUES ('${STEP.s1}', '${WS_A}', '${SEQ}', 0, 0, 'email', 'email', '10:00', 'Hola'),
           ('${STEP.s2}', '${WS_A}', '${SEQ}', 2, 0, 'email_reply', 'email', '10:00', 'Sigo'),
           ('${STEP.s3}', '${WS_A}', '${SEQ}', 4, 0, 'linkedin_message', 'linkedin', '10:00', 'Hola por aquí'),
           ('${STEP.b1}', '${WS_B}', '${SEQ_B}', 0, 0, 'email', 'email', '10:00', 'Hola');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status, finished_at) VALUES
      ${PEOPLE.map((n) => `('${enrollment(n)}', '${WS_A}', '${SEQ}', '${contact(n)}', '${ENROLLMENT_STATUS[n]}', ${ENROLLMENT_STATUS[n] === 'active' ? 'NULL' : 'now() - interval \'2 days\''})`).join(',\n')},
      ('${enrollment(9)}', '${WS_B}', '${SEQ_B}', '${contact(9)}', 'active', NULL);
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
                                subject, body, status, scheduled_for, sent_at, attempt_count, recipient_address, provider_message_id,
                                opened_at, replied_at, held_reason, blocked_reason, claimed_at, status_changed_at, channel_account_id)
    VALUES ${PEOPLE.flatMap((n) => WEEK[n].map((f, i) => touchSql(n, (i + 1) as 1 | 2 | 3, f))).join(',\n')};
    -- Un enviado de la cadencia sin paso (los de 0007): no entra en ningún embudo, sí en la salud.
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, channel, subject, body, status, sent_at,
                                recipient_address, provider_message_id, status_changed_at)
    VALUES ('${id('7a')}', '${WS_A}', '${CO}', '${contact(6)}', '${SEQ}', 'email', 'Suelto', 'Hola.', 'sent', now() - interval '1 day',
            'c6@marca.test', 'prov-suelto', now() - interval '1 day');
    -- El de B: enviado y respondido con interés.
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, enrollment_id, step_id, channel, subject, body,
                                status, sent_at, recipient_address, provider_message_id, replied_at, status_changed_at)
    VALUES ('${id('7b')}', '${WS_B}', '${CO_B}', '${contact(9)}', '${SEQ_B}', '${enrollment(9)}', '${STEP.b1}', 'email', 'Hola', 'Hola.',
            'sent', now() - interval '2 days', 'b@marca-b.test', 'prov-b', now() - interval '1 day', now() - interval '2 days');
    -- El enlace de baja del correo que está en processing (0037 §4.5).
    INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at)
    VALUES (repeat('b', 64), '${WS_A}', '${touch(7, 2)}', '${contact(7)}', 1, 'c7@marca.test', now());
  `);
  const inbound: string[] = [];
  for (const n of PEOPLE) {
    WEEK[n].forEach((f, i) => (f.intents ?? []).forEach((intent, k) => {
      const tid = touch(n, (i + 1) as 1 | 2 | 3);
      inbound.push(`('${WS_A}', '${tid}', '${contact(n)}', '${enrollment(n)}', 'inbound', 'email', 'hilo-${n}', 'resp-${n}-${i}-${k}',
        'Respuesta ${k}', '${intent}', ${ts(f.ago)} + interval '6 hours')`);
    }));
  }
  await t.admin(`
    INSERT INTO outbound_message (workspace_id, touch_id, contact_id, enrollment_id, direction, channel, thread_ref, provider_message_id,
                                  body, intent, occurred_at)
    VALUES ${inbound.join(',\n')},
           ('${WS_B}', '${id('7b')}', '${contact(9)}', '${enrollment(9)}', 'inbound', 'email', 'hilo-b', 'resp-b', 'Sí', 'interested',
            now() - interval '1 day');
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t?.close();
});

/** Las filas de outbound_touch tal cual, leídas como el worker (sin RLS), para contar a mano. */
async function rawTouches(workspaceId: string) {
  return t.db.asWorker(async (tx) =>
    (await tx.query<{ id: string; step_id: string | null; status: string; opened: boolean; replied: boolean; positive: boolean }>(
      `SELECT t.id, t.step_id, t.status, t.opened_at IS NOT NULL AS opened, t.replied_at IS NOT NULL AS replied,
              EXISTS (SELECT 1 FROM outbound_message m WHERE m.touch_id = t.id AND m.direction = 'inbound' AND m.intent = 'interested') AS positive
         FROM outbound_touch t WHERE t.workspace_id = $1 ORDER BY t.id`,
      [workspaceId],
    )).rows,
  );
}

describe('el embudo por paso (outbound_funnel_by_step)', () => {
  test('cuadra con outbound_touch fila a fila: cada toque del paso cae en una sola columna, y las marcas solo dentro de lo enviado', async () => {
    const funnel = await t.db.withWorkspace(WS_A, (tx) => listFunnelByStep(tx, SEQ));
    const touches = await rawTouches(WS_A);
    assert.equal(funnel.length, 3, 'un paso por fila, también sin toques');
    for (const step of funnel) {
      const mine = touches.filter((x) => x.step_id === step.stepId);
      const sent = mine.filter((x) => x.status === 'sent');
      assert.equal(step.touches, mine.length, `paso ${step.position}: toques`);
      assert.equal(step.sent, sent.length, `paso ${step.position}: enviados`);
      assert.equal(step.opened, sent.filter((x) => x.opened).length, `paso ${step.position}: abiertos`);
      assert.equal(step.replied, sent.filter((x) => x.replied).length, `paso ${step.position}: respondidos`);
      assert.equal(step.positive, sent.filter((x) => x.positive).length, `paso ${step.position}: positivos`);
      assert.equal(step.pending, mine.filter((x) => ['draft', 'scheduled', 'processing', 'held'].includes(x.status)).length);
      assert.equal(step.failed, mine.filter((x) => x.status === 'failed').length);
      assert.equal(step.stopped, mine.filter((x) => x.status === 'canceled' || x.status === 'skipped').length);
      assert.equal(step.sent + step.pending + step.failed + step.stopped, step.touches, 'cada toque en una sola columna');
      assert.ok(step.opened <= step.sent && step.replied <= step.sent && step.positive <= step.replied, 'el embudo no crece hacia abajo');
    }
    // Y cada toque de la cadencia con paso está en exactamente uno de los tres pasos.
    const withStep = touches.filter((x) => x.step_id !== null && [STEP.s1, STEP.s2, STEP.s3].includes(x.step_id));
    assert.equal(funnel.reduce((n, s) => n + s.touches, 0), withStep.length);
  });

  test('y con la tabla escrita a mano, con sus tasas sobre lo enviado (null sin envíos)', async () => {
    const funnel = await t.db.withWorkspace(WS_A, (tx) => listFunnelByStep(tx, SEQ));
    assert.deepEqual(
      funnel.map(({ position, sent, opened, replied, positive, pending, failed, stopped }) =>
        ({ position, sent, opened, replied, positive, pending, failed, stopped })),
      EXPECTED,
    );
    assert.deepEqual(funnel.map((s) => s.stepType), ['email', 'email_reply', 'linkedin_message']);
    assert.deepEqual(funnel.map((s) => s.opensTracked), [true, true, false], 'solo el correo lleva píxel');
    assert.equal(funnel[0]!.replyRate, 0.4);
    assert.equal(funnel[0]!.positiveRate, 0.4);
    assert.equal(funnel[1]!.openRate, 0.6667);
    assert.equal(funnel[2]!.replyRate, null, '0 de 0 no es 0 %');
  });

  test('otro workspace no ve el embudo ajeno, y el suyo no mezcla nada de A', async () => {
    assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => listFunnelByStep(tx, SEQ)), []);
    const b = await t.db.withWorkspace(WS_B, (tx) => listFunnelByStep(tx, SEQ_B));
    assert.deepEqual(b.map((s) => [s.sent, s.replied, s.positive]), [[1, 1, 1]]);
    const colaB = await t.db.withWorkspace(WS_B, (tx) => listOutboundQueue(tx, { bucket: 'history' }));
    assert.deepEqual(colaB.rows.map((r) => r.touchId), [id('7b')]);
  });
});

describe('la salud de la secuencia (outbound_sequence_health)', () => {
  test('suma lo mismo que el embudo, más lo enviado sin paso, y enciende el semáforo', async () => {
    const h = await t.db.withWorkspace(WS_A, (tx) => getSequenceHealth(tx, SEQ));
    assert.ok(h);
    const funnel = await t.db.withWorkspace(WS_A, (tx) => listFunnelByStep(tx, SEQ));
    const sum = (k: 'sent' | 'replied' | 'positive' | 'failed') => funnel.reduce((n, s) => n + s[k], 0);
    assert.equal(h.sent, sum('sent') + 1, 'el enviado sin paso cuenta en la secuencia');
    assert.equal(h.replied, sum('replied'));
    assert.equal(h.positive, sum('positive'));
    assert.equal(h.failed, sum('failed'));
    assert.equal(h.held, 1);
    assert.equal(h.pending, 5, 'draft, scheduled y processing');
    assert.deepEqual(
      [h.enrolled, h.enrolledActive, h.enrolledReplied, h.enrolledCompleted, h.enrolledPaused, h.enrolledStopped],
      [8, 4, 3, 1, 0, 0],
    );
    // En 7 días: 4 fallidos frente a 7 enviados (los dos de hace justo 7 días quedan fuera): 4 / 11 ≥ 20 %.
    assert.equal(h.failed7d, 4);
    assert.equal(h.sent7d, 7);
    assert.equal(h.failureRate7d, 0.3636);
    assert.equal(h.health, 'failing');
    assert.equal(await t.db.withWorkspace(WS_B, (tx) => getSequenceHealth(tx, SEQ)), null, 'lo ajeno no se ve');
    const lista = await t.db.withWorkspace(WS_B, (tx) => listSequenceHealth(tx));
    assert.deepEqual(lista.map((x) => [x.sequenceId, x.health]), [[SEQ_B, 'healthy']]);
  });
});

describe('la cola y el historial (outbound_queue)', () => {
  test('las dos pestañas reparten los ocho estados sin dejar ninguno fuera', () => {
    const all = [...QUEUE_BUCKET_STATUSES.queue, ...QUEUE_BUCKET_STATUSES.history].sort();
    assert.deepEqual(all, [...TOUCH_STATUSES].sort());
  });

  test('la cola enseña primero lo fallido, con su motivo en código y si se puede reintentar', async () => {
    const { rows } = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'queue' }));
    const failed = rows.filter((r) => r.status === 'failed');
    assert.equal(failed.length, 4);
    assert.ok(rows.slice(0, 4).every((r) => r.status === 'failed'), 'lo fallido va arriba');
    const byId = new Map(rows.map((r) => [r.touchId, r]));
    const maxAttempts = byId.get(touch(3, 3))!;
    assert.deepEqual(
      [maxAttempts.reason, maxAttempts.retryable, maxAttempts.stepType, maxAttempts.stepPosition, maxAttempts.contactName,
        maxAttempts.sequenceName],
      ['max_attempts', true, 'linkedin_message', 3, 'Persona 3', 'Semana de prueba'],
    );
    assert.equal(byId.get(touch(5, 1))!.retryable, false, 'un rebote no se reintenta');
    assert.equal(byId.get(touch(7, 1))!.retryable, false, 'un zombi no se reintenta: pudo haber salido');
    assert.equal(byId.get(touch(6, 2))!.reason, 'needs_review', 'el retenido lleva su held_reason');
    assert.equal(byId.get(touch(7, 2))!.cancelable, false, 'lo reclamado es del despachador');
    assert.equal(rows.some((r) => r.status === 'sent'), false, 'lo enviado va al historial');
  });

  test('los filtros: secuencia, tipo de paso y contacto (nombre, correo o empresa)', async () => {
    const f = (filters: Parameters<typeof listOutboundQueue>[1]) =>
      t.db.withWorkspace(WS_A, async (tx) => (await listOutboundQueue(tx, filters)).rows.map((r) => r.touchId).sort());
    assert.deepEqual(await f({ bucket: 'queue', stepType: 'linkedin_message', statuses: ['failed'] }), [touch(3, 3)]);
    assert.deepEqual(await f({ bucket: 'history', contact: 'c2@marca' }), [touch(2, 1), touch(2, 2), touch(2, 3)].sort());
    assert.deepEqual(await f({ bucket: 'history', contact: 'persona 6', stepType: 'email' }), [touch(6, 1)]);
    assert.deepEqual(await f({ bucket: 'queue', contact: '100%_' }), [], 'los comodines de LIKE se escapan');
    assert.deepEqual(await f({ bucket: 'queue', sequenceId: SEQ_B }), []);
    const facets = await t.db.withWorkspace(WS_A, (tx) => getQueueFacets(tx, {}));
    assert.deepEqual(facets.sequences, [{ id: SEQ, name: 'Semana de prueba' }]);
    assert.deepEqual(facets.stepTypes, ['email', 'email_reply', 'linkedin_message']);
    assert.deepEqual(facets.retryableByStepType, [{ stepType: 'email', count: 1 }, { stepType: 'linkedin_message', count: 1 }]);
    assert.deepEqual(facets.counts, { queue: 10, history: 15 });
  });

  test('reintentar el fallido lo devuelve a scheduled y reabre la cadencia que se completó por él', async () => {
    const antes = Date.now();
    const report = await t.db.withWorkspace(WS_A, (tx) => retryFailedTouches(tx, { touchIds: [touch(3, 3)] }));
    assert.deepEqual(report, { done: [touch(3, 3)], skipped: [] });
    const fila = await t.db.asWorker(async (tx) => (await tx.query<{
      status: string; blocked_reason: string | null; next_retry_at: unknown; scheduled_for: Date; attempt_count: number; enr: string;
      finished: unknown; current: string | null;
    }>(
      `SELECT t.status, t.blocked_reason, t.next_retry_at, t.scheduled_for, t.attempt_count, e.status AS enr, e.finished_at AS finished,
              e.current_step_id AS current
         FROM outbound_touch t JOIN outbound_enrollment e ON e.id = t.enrollment_id WHERE t.id = $1`, [touch(3, 3)],
    )).rows[0]!);
    assert.equal(fila.status, 'scheduled');
    assert.equal(fila.blocked_reason, null);
    assert.equal(fila.next_retry_at, null);
    assert.ok(new Date(fila.scheduled_for).getTime() >= antes - 1000, 'sale en la próxima pasada del despachador');
    assert.equal(fila.attempt_count, 1, 'los intentos no vuelven a cero: cada uno tiene su enlace de baja');
    assert.deepEqual([fila.enr, fila.finished, fila.current], ['active', null, STEP.s3]);
    const { rows } = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'queue', statuses: ['scheduled'] }));
    const vuelto = rows.find((r) => r.touchId === touch(3, 3))!;
    assert.deepEqual([vuelto.status, vuelto.reason], ['scheduled', null], 'en la cola, programado y sin el motivo viejo');
  });

  test('lo que un reintento no arregla no vuelve, cada uno con su motivo; lo ajeno no se ve', async () => {
    const report = await t.db.withWorkspace(WS_A, (tx) =>
      retryFailedTouches(tx, { touchIds: [touch(5, 1), touch(7, 1), touch(8, 1), touch(6, 1), id('7b')] }));
    assert.deepEqual(report.done, []);
    assert.deepEqual(
      Object.fromEntries(report.skipped.map((s) => [s.touchId, s.code])),
      {
        [touch(5, 1)]: 'not_retryable',
        [touch(7, 1)]: 'not_retryable',
        [touch(8, 1)]: 'superseded',
        [touch(6, 1)]: 'not_failed',
        [id('7b')]: 'not_found',
      },
    );
    const b = await t.db.withWorkspace(WS_B, (tx) => retryFailedTouches(tx, { stepType: 'email' }));
    assert.deepEqual(b, { done: [], skipped: [] }, 'B no alcanza los fallidos de A');
  });

  test('reintentar por tipo de paso toma los fallidos reintentables de ese tipo con los filtros', async () => {
    const report = await t.db.withWorkspace(WS_A, (tx) => retryFailedTouches(tx, { stepType: 'email', sequenceId: SEQ }));
    // El único fallido reintentable de correo es el de c8, y ya salió su paso siguiente.
    assert.deepEqual(report, { done: [], skipped: [{ touchId: touch(8, 1), code: 'superseded' }] });
  });

  test('cancelar en masa cancela lo cancelable, deja lo demás con su motivo y avanza la cadencia', async () => {
    const report = await t.db.withWorkspace(WS_A, (tx) =>
      cancelQueuedTouches(tx, [touch(6, 2), touch(6, 3), touch(7, 2), touch(2, 2), id('7b')]));
    assert.deepEqual([...report.done].sort(), [touch(6, 2), touch(6, 3)].sort());
    assert.deepEqual(
      Object.fromEntries(report.skipped.map((s) => [s.touchId, s.code])),
      { [touch(7, 2)]: 'not_cancelable', [touch(2, 2)]: 'not_cancelable', [id('7b')]: 'not_found' },
    );
    const enr = await t.db.asWorker(async (tx) => (await tx.query<{ status: string; reason: string | null; e: string }>(
      `SELECT t.status, t.blocked_reason AS reason, e.status AS e FROM outbound_touch t JOIN outbound_enrollment e ON e.id = t.enrollment_id
        WHERE t.id = $1`, [touch(6, 2)],
    )).rows[0]!);
    assert.deepEqual({ ...enr }, { status: 'canceled', reason: 'canceled_by_user', e: 'completed' }, 'a c6 no le queda nada vivo');
    const { rows } = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'history', statuses: ['canceled'] }));
    assert.equal(rows.find((r) => r.touchId === touch(6, 2))?.reason, 'canceled_by_user');
  });
});

describe('el uso por canal (outbound_usage_daily)', () => {
  test('hoy, con el límite duro pasado por la curva de calentamiento, y el semáforo', async () => {
    const usage = await t.db.withWorkspace(WS_A, (tx) => listChannelUsage(tx));
    assert.deepEqual(usage.map((u) => u.channel), ['email', 'linkedin']);
    const [email, linkedin] = usage as [(typeof usage)[number], (typeof usage)[number]];
    // El correo: tope 50 (la cuenta, bajo los 80 de la política), en su cuarto día de calentamiento de 14.
    const day = warmupDay(new Date(Date.now() - 3 * 86_400_000), new Date(), TZ);
    assert.equal(email.dailyLimit, 50);
    assert.equal(email.hardLimit, warmupDailyLimit({ day, policyLimit: 50, warmupDays: 14 }));
    assert.equal(email.hardLimit, 20);
    assert.deepEqual([email.used, email.softLimit, email.level, email.warmingUp], [17, 16, 'near', true]);
    assert.equal(email.providerLimit, 2000);
    assert.equal(email.history.length, 14);
    assert.equal(email.history.at(-1)!.used, 17, 'el último día es hoy');
    assert.equal(email.history.at(-4)!.used, 9, 'hace tres días');
    assert.equal(email.history.reduce((n, d) => n + d.used, 0), 26, 'la fila del workspace entero no cuenta en la cuenta');
    // LinkedIn: sin calentamiento, 25 de 25.
    assert.deepEqual(
      [linkedin.used, linkedin.hardLimit, linkedin.level, linkedin.warmingUp, linkedin.usedShare],
      [25, 25, 'full', false, 1],
    );
    assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => listChannelUsage(tx)), [], 'B no tiene cuentas');
  });

  test('el día del calentamiento de la vista es el de warmupDay, en la zona del workspace', async () => {
    const rows = await t.db.withWorkspace(WS_A, (tx) => tx.query<{ warmup_day: number }>(
      `SELECT warmup_day FROM outbound_usage_daily WHERE channel_account_id = $1 AND is_today`, [ACC.email],
    ));
    const started = await t.db.asWorker(async (tx) => (await tx.query<{ w: Date }>(
      `SELECT warmup_started_at AS w FROM outreach_channel_account WHERE id = $1`, [ACC.email],
    )).rows[0]!.w);
    assert.equal(rows.rows[0]!.warmup_day, warmupDay(new Date(started), new Date(), TZ));
  });

  test('el semáforo: ok por debajo del blando, near hasta el duro, full en el duro', () => {
    assert.equal(usageLevel(0, 16, 20), 'ok');
    assert.equal(usageLevel(15, 16, 20), 'ok');
    assert.equal(usageLevel(16, 16, 20), 'near');
    assert.equal(usageLevel(20, 16, 20), 'full');
    assert.equal(usageLevel(0, 0, 0), 'full', 'un tope de cero no deja salir nada');
  });

  test('la web solo lee las vistas: sin INSERT, UPDATE ni DELETE para mc_app', async () => {
    const { rows } = await t.db.withCatalogs((tx) => tx.query<{ view: string; lee: boolean; escribe: boolean }>(
      `SELECT v AS view, has_table_privilege('mc_app', v, 'SELECT') AS lee,
              has_table_privilege('mc_app', v, 'INSERT') OR has_table_privilege('mc_app', v, 'UPDATE')
                OR has_table_privilege('mc_app', v, 'DELETE') AS escribe
         FROM unnest(ARRAY['outbound_queue', 'outbound_usage_daily', 'outbound_funnel_by_step', 'outbound_sequence_health']) AS v
        ORDER BY 1`,
    ));
    assert.deepEqual(rows.map((r) => [r.view, r.lee, r.escribe]), [
      ['outbound_funnel_by_step', true, false], ['outbound_queue', true, false],
      ['outbound_sequence_health', true, false], ['outbound_usage_daily', true, false],
    ]);
  });
});
