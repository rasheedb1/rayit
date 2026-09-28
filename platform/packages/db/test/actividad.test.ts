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
 *     reintento no arregla (rebote, zombi, un paso posterior ya enviado,
 *     los intentos agotados, la cuenta caída) ni se ofrece ni vuelve, y la
 *     regla es la misma en la vista, en los botones por tipo y en el
 *     reintento (outbound_touch_retry_block);
 *   · la cola y el historial se recorren por páginas con cursor, sin
 *     repetir ni saltar filas (también 205 envíos con horas repetidas);
 *   · cancelar en masa cancela lo cancelable y avanza la cadencia;
 *   · el uso por canal: el límite duro pasa por la curva de calentamiento
 *     de @mc/core, el día del calentamiento de la vista es el de warmupDay,
 *     manda el tope con menos cupo (el día, la semana o el espacio, como
 *     el reclamo) y el semáforo dice ok, near, full u off (cuenta caída o
 *     envío apagado);
 *   · la salud de la secuencia cuadra con el embudo;
 *   · ronda 4 (0072 §1b): la cola y el embudo numeran el paso con la misma
 *     regla, una respuesta «me interesa» sin replied_at no es positiva, y
 *     getQueueBlockers dice qué para la cola como la para el reclamo.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { warmupDailyLimit, warmupDay } from '@mc/core/outreach/warmup';
import {
  ACCOUNT_FAILURES, cancelQueuedTouches, getQueueBlockers, getQueueFacets, getSequenceHealth, listChannelUsage, listFunnelByStep, listOutboundQueue,
  listSequenceHealth, MAX_TOUCH_ATTEMPTS, NOT_RETRYABLE_FAILURES, parseQueueCursor, QUEUE_BUCKET_STATUSES, QUEUE_PAGE_SIZE,
  retryFailedTouches, retryScheduledFor, usageBinding, usageLevel, type QueuePage,
} from '../src/queries/actividad.ts';
import { TOUCH_STATUSES } from '../src/schema/ventas.ts';
import { membershipSql } from './membresia.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const id = (kind: string) => `00000065-0000-4000-8000-${kind.padStart(12, '0')}`;
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
    INSERT INTO outbound_policy (workspace_id, postal_address, max_emails_per_day, warmup_days, enabled)
    VALUES ('${WS_A}', 'Calle 93 # 11-26, Bogotá', 80, 14, true);
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
    -- El enlace de baja del correo que está en processing (0046 §4.5).
    INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at)
    VALUES (repeat('b', 64), '${WS_A}', '${touch(7, 2)}', '${contact(7)}', 1, 'c7@marca.test', now());
  `);
  const inbound: string[] = [];
  for (const n of PEOPLE) {
    WEEK[n].forEach((f, i) => (f.intents ?? []).forEach((intent, k) => {
      const tid = touch(n, (i + 1) as 1 | 2 | 3);
      // Clasificada como la deja el clasificador: con su intención y su hora (classified_at).
      inbound.push(`('${WS_A}', '${tid}', '${contact(n)}', '${enrollment(n)}', 'inbound', 'email', 'hilo-${n}', 'resp-${n}-${i}-${k}',
        'Respuesta ${k}', '${intent}', ${ts(f.ago)} + interval '7 hours', ${ts(f.ago)} + interval '6 hours')`);
    }));
  }
  await t.admin(`
    INSERT INTO outbound_message (workspace_id, touch_id, contact_id, enrollment_id, direction, channel, thread_ref, provider_message_id,
                                  body, intent, classified_at, occurred_at)
    VALUES ${inbound.join(',\n')},
           ('${WS_B}', '${id('7b')}', '${contact(9)}', '${enrollment(9)}', 'inbound', 'email', 'hilo-b', 'resp-b', 'Sí', 'interested',
            now() - interval '23 hours', now() - interval '1 day');
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
              t.replied_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM outbound_message m WHERE m.touch_id = t.id AND m.direction = 'inbound' AND m.intent = 'interested')
                AS positive
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
    // La barra de la vista de flujo: lo de cada paso sobre lo enviado en el primero, calculado en la vista (pulido r1).
    const first = funnel[0]!.sent;
    for (const s of funnel) {
      const share = (n: number) => (first > 0 ? Math.min(1, Math.round((n / first) * 10_000) / 10_000) : null);
      assert.deepEqual(s.shareOfFirst, { sent: share(s.sent), opened: share(s.opened), replied: share(s.replied) }, `paso ${s.position}`);
    }
    assert.equal(funnel[0]!.shareOfFirst.sent, 1);
    // De lo fallido, lo que la actividad deja reintentar: la misma regla que su botón.
    const facets = await t.db.withWorkspace(WS_A, (tx) => getQueueFacets(tx, { sequenceId: SEQ }));
    for (const s of funnel) {
      assert.ok(s.failedRetryable <= s.failed, `paso ${s.position}: no más reintentables que fallidos`);
    }
    const porTipo = new Map(facets.retryableByStepType.map((x) => [x.stepType, x.count]));
    for (const tipo of new Set(funnel.map((s) => s.stepType))) {
      assert.equal(
        funnel.filter((s) => s.stepType === tipo).reduce((n, s) => n + s.failedRetryable, 0), porTipo.get(tipo) ?? 0,
        `${tipo}: el embudo y el botón de reintentar cuentan lo mismo`,
      );
    }
  });

  test('otro workspace no ve el embudo ajeno, y el suyo no mezcla nada de A', async () => {
    assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => listFunnelByStep(tx, SEQ)), []);
    const b = await t.db.withWorkspace(WS_B, (tx) => listFunnelByStep(tx, SEQ_B));
    assert.deepEqual(b.map((s) => [s.sent, s.replied, s.positive]), [[1, 1, 1]]);
    const colaB = await t.db.withWorkspace(WS_B, (tx) => listOutboundQueue(tx, { bucket: 'history' }));
    assert.deepEqual(colaB.rows.map((r) => r.touchId), [id('7b')]);
  });

  test('la cola y el embudo numeran el paso con la misma regla (outbound_step_position)', async () => {
    const funnel = await t.db.withWorkspace(WS_A, (tx) => listFunnelByStep(tx, SEQ));
    const position = new Map(funnel.map((s) => [s.stepId, s.position]));
    for (const bucket of ['queue', 'history'] as const) {
      const { rows } = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket, sequenceId: SEQ }));
      for (const r of rows.filter((x) => x.stepId !== null)) {
        assert.equal(r.stepPosition, position.get(r.stepId!), `${r.touchId}: el mismo número en la cola y en el embudo`);
      }
    }
  });

  test('una respuesta «me interesa» sin replied_at no es positiva: el embudo no crece hacia abajo', async () => {
    // B: un segundo enviado, con una respuesta entrante clasificada como interested pero sin replied_at (una
    // importación, un reproceso). Va al final: los números de B de arriba ya se comprobaron.
    const huerfano = id('7bb');
    await t.admin(`
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_id, channel, subject, body, status,
                                  sent_at, recipient_address, provider_message_id, status_changed_at)
      VALUES ('${huerfano}', '${WS_B}', '${CO_B}', '${contact(9)}', '${SEQ_B}', '${STEP.b1}', 'email', 'Otra vez', 'Hola.', 'sent',
              now() - interval '1 day', 'b@marca-b.test', 'prov-b-2', now() - interval '1 day');
      INSERT INTO outbound_message (workspace_id, touch_id, contact_id, direction, channel, thread_ref, provider_message_id, body,
                                    intent, classified_at, occurred_at)
      VALUES ('${WS_B}', '${huerfano}', '${contact(9)}', 'inbound', 'email', 'hilo-b-2', 'resp-b-2', 'Sí, cuéntame', 'interested',
              now() - interval '20 hours', now() - interval '21 hours');
    `);
    const [paso] = await t.db.withWorkspace(WS_B, (tx) => listFunnelByStep(tx, SEQ_B));
    assert.deepEqual([paso!.sent, paso!.replied, paso!.positive], [2, 1, 1], 'el de sin replied_at no cuenta como positivo');
    assert.ok(paso!.positive <= paso!.replied);
    const salud = await t.db.withWorkspace(WS_B, (tx) => getSequenceHealth(tx, SEQ_B));
    assert.deepEqual([salud!.sent, salud!.replied, salud!.positive], [2, 1, 1], 'la salud cuenta los mismos positivos que el embudo');
    const directo = await t.db.withWorkspace(WS_B, async (tx) => (await tx.query<{ p: boolean }>(
      `SELECT outbound_touch_is_positive(t) AS p FROM outbound_touch t WHERE t.id = $1`, [huerfano],
    )).rows[0]!.p);
    assert.equal(directo, false);
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
    // La lista de /ventas/cadencias pide la salud de sus filas por id: lo ajeno no vuelve.
    const lista = await t.db.withWorkspace(WS_B, (tx) => listSequenceHealth(tx, [SEQ_B, SEQ, 'no-es-uuid']));
    assert.deepEqual([...lista].map(([k, x]) => [k, x.health]), [[SEQ_B, 'healthy']]);
    const deA = await t.db.withWorkspace(WS_A, (tx) => listSequenceHealth(tx, [SEQ]));
    assert.equal(deA.get(SEQ)?.health, 'failing', 'la misma fila que getSequenceHealth');
    assert.equal((await t.db.withWorkspace(WS_A, (tx) => listSequenceHealth(tx, []))).size, 0);
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
    assert.equal(maxAttempts.retryBlock, null);
    assert.deepEqual([byId.get(touch(5, 1))!.retryable, byId.get(touch(5, 1))!.retryBlock], [false, 'not_retryable'], 'un rebote no se reintenta');
    assert.deepEqual([byId.get(touch(7, 1))!.retryable, byId.get(touch(7, 1))!.retryBlock], [false, 'not_retryable'],
      'un zombi no se reintenta: pudo haber salido');
    // c8 falló en el paso 1, pero su paso 2 ya salió: la fila no ofrece un «Reintentar» que nunca haría nada.
    assert.deepEqual([byId.get(touch(8, 1))!.retryable, byId.get(touch(8, 1))!.retryBlock], [false, 'superseded']);
    assert.equal(byId.get(touch(3, 3))!.accountStatus, 'connected', 'el estado de la cuenta con la que se intentó');
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
    // El fallido de correo de c8 no cuenta: su paso siguiente ya salió (superseded). El botón «Correo · 1» sería un botón muerto.
    assert.deepEqual(facets.retryableByStepType, [{ stepType: 'linkedin_message', count: 1 }]);
    assert.deepEqual(facets.counts, { queue: 10, history: 15 });
    // Lo cancelable de la cola: todo menos lo que se está enviando (c7, paso 2).
    assert.equal(facets.cancelable, 9);
    // Con los filtros: los conteos de las pestañas y los reintentables salen de la misma pasada.
    const persona3 = await t.db.withWorkspace(WS_A, (tx) => getQueueFacets(tx, { contact: 'persona 3' }));
    assert.deepEqual(persona3.counts, { queue: 1, history: 2 });
    assert.equal(persona3.cancelable, 1);
    assert.deepEqual(persona3.retryableByStepType, [{ stepType: 'linkedin_message', count: 1 }]);
    const soloCorreo = await t.db.withWorkspace(WS_A, (tx) => getQueueFacets(tx, { stepType: 'email', sequenceId: SEQ }));
    assert.deepEqual(soloCorreo.retryableByStepType, []);
    assert.deepEqual(soloCorreo.counts, { queue: 3, history: 5 });
    assert.equal(soloCorreo.cancelable, 3);
    const nada = await t.db.withWorkspace(WS_B, (tx) => getQueueFacets(tx, { sequenceId: SEQ }));
    assert.deepEqual([nada.counts, nada.retryableByStepType], [{ queue: 0, history: 0 }, []], 'lo ajeno no se cuenta');
    assert.equal(nada.cancelable, 0);
  });

  test('la cola dice cuándo la cadencia está en pausa (sequence_status): el despachador aplaza lo suyo cada día', async () => {
    const programado = async () => (await t.db.withWorkspace(WS_A, (tx) =>
      listOutboundQueue(tx, { bucket: 'queue', statuses: ['scheduled'], sequenceId: SEQ }))).rows.find((r) => r.touchId === touch(5, 3))!;
    assert.deepEqual([(await programado()).sequenceStatus, (await programado()).enrollmentStatus], ['active', 'active']);
    await t.admin(`UPDATE outbound_sequence SET status = 'paused' WHERE id = '${SEQ}'`);
    try {
      const pausado = await programado();
      assert.deepEqual([pausado.status, pausado.sequenceStatus, pausado.enrollmentStatus], ['scheduled', 'paused', 'active']);
      // Solo cambia la columna nueva: lo demás de la fila es lo de siempre.
      assert.equal(pausado.stepPosition, 3);
    } finally {
      await t.admin(`UPDATE outbound_sequence SET status = 'active' WHERE id = '${SEQ}'`);
    }
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

  test('reintentar por tipo de paso toma solo los fallidos que la base deja volver', async () => {
    const report = await t.db.withWorkspace(WS_A, (tx) => retryFailedTouches(tx, { stepType: 'email', sequenceId: SEQ }));
    // Los tres fallidos de correo están bloqueados (rebote, zombi y c8, cuyo paso siguiente ya salió): no se toca ninguno.
    assert.deepEqual(report, { done: [], skipped: [] });
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

  test('el bloqueo de la base usa las mismas listas que @mc/db (NOT_RETRYABLE_FAILURES, ACCOUNT_FAILURES, MAX_TOUCH_ATTEMPTS)', async () => {
    // Sobre el enviado suelto de c6 (sin cadencia), cambiado en memoria con jsonb_populate_record: nada se escribe.
    const block = (overrides: Record<string, unknown>) => t.db.withWorkspace(WS_A, async (tx) => (await tx.query<{ b: string | null }>(
      `SELECT outbound_touch_retry_block(jsonb_populate_record(t, $2::jsonb)) AS b FROM outbound_touch t WHERE t.id = $1`,
      [id('7a'), JSON.stringify({ status: 'failed', ...overrides })],
    )).rows[0]!.b);
    for (const code of NOT_RETRYABLE_FAILURES) assert.equal(await block({ blocked_reason: code }), 'not_retryable', code);
    for (const code of ACCOUNT_FAILURES) {
      assert.equal(await block({ blocked_reason: code }), null, `${code}: hay un correo conectado`);
      assert.equal(await block({ blocked_reason: code, channel: 'whatsapp' }), 'account_down', `${code}: ningún WhatsApp conectado`);
    }
    assert.equal(await block({ blocked_reason: 'rejected', channel: 'whatsapp' }), null, 'un fallo del mensaje no es de la cuenta');
    assert.equal(await block({ blocked_reason: 'rejected', attempt_count: MAX_TOUCH_ATTEMPTS - 2 }), null);
    assert.equal(await block({ blocked_reason: 'rejected', attempt_count: MAX_TOUCH_ATTEMPTS - 1 }), 'too_many_attempts');
    assert.equal(await block({ status: 'scheduled', blocked_reason: 'bounced' }), null, 'lo que no está fallido no se bloquea');
  });

  test('un fallido que ya gastó los intentos no vuelve: el reclamo lo subiría por encima del CHECK de 0046', async () => {
    await t.admin(`
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, blocked_reason,
                                  attempt_count, scheduled_for, status_changed_at)
      VALUES ('${id('7c')}', '${WS_A}', '${CO}', '${contact(4)}', 'email', 'Sin techo', 'Hola.', 'failed', 'max_attempts',
              ${MAX_TOUCH_ATTEMPTS - 1}, now() - interval '1 day', now() - interval '1 hour'),
             ('${id('7d')}', '${WS_A}', '${CO}', '${contact(4)}', 'email', 'Con uno de margen', 'Hola.', 'failed', 'max_attempts',
              ${MAX_TOUCH_ATTEMPTS - 2}, now() - interval '1 day', now() - interval '1 hour');
    `);
    const { rows } = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'queue', statuses: ['failed'] }));
    const lleno = rows.find((r) => r.touchId === id('7c'))!;
    assert.deepEqual([lleno.retryable, lleno.retryBlock, lleno.attemptCount], [false, 'too_many_attempts', 19]);
    assert.deepEqual([lleno.sequenceStatus, lleno.enrollmentStatus], [null, null], 'un toque suelto no tiene cadencia que pausar');
    const report = await t.db.withWorkspace(WS_A, (tx) => retryFailedTouches(tx, { touchIds: [id('7c'), id('7d')] }));
    assert.deepEqual(report, { done: [id('7d')], skipped: [{ touchId: id('7c'), code: 'too_many_attempts' }] });
    const despues = await t.db.asWorker(async (tx) => (await tx.query<{ id: string; status: string; attempt_count: number }>(
      `SELECT id, status, attempt_count FROM outbound_touch WHERE id = ANY($1::uuid[]) ORDER BY id`, [[id('7c'), id('7d')]],
    )).rows.map((r) => [r.status, r.attempt_count]));
    assert.deepEqual(despues, [['failed', 19], ['scheduled', 18]], 'el que cabe vuelve; su reclamo lo dejará en 19, dentro del CHECK');
  });

  test('un fallo de la cuenta no se ofrece mientras el canal no tenga ninguna cuenta conectada', async () => {
    await t.admin(`
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, blocked_reason, attempt_count,
                                  scheduled_for, status_changed_at, channel_account_id)
      VALUES ('${id('7e')}', '${WS_A}', '${CO}', '${contact(6)}', 'linkedin', 'Hola por aquí.', 'failed', 'account_auth', 1,
              now() - interval '1 day', now() - interval '2 hours', '${ACC.linkedin}');
    `);
    const fila = async () => (await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'queue', statuses: ['failed'] })))
      .rows.find((r) => r.touchId === id('7e'))!;
    assert.deepEqual([(await fila()).retryable, (await fila()).accountStatus], [true, 'connected'], 'con LinkedIn conectado, sí');
    await t.admin(`UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = '${ACC.linkedin}'`);
    try {
      const caida = await fila();
      assert.deepEqual([caida.retryable, caida.retryBlock, caida.accountStatus], [false, 'account_down', 'needs_reconnect']);
      const report = await t.db.withWorkspace(WS_A, (tx) => retryFailedTouches(tx, { touchIds: [id('7e')] }));
      assert.deepEqual(report, { done: [], skipped: [{ touchId: id('7e'), code: 'account_down' }] });
    } finally {
      await t.admin(`UPDATE outreach_channel_account SET status = 'connected' WHERE id = '${ACC.linkedin}'`);
    }
  });
});

describe('lo que para la cola (getQueueBlockers)', () => {
  test('el interruptor del espacio, los canales sin cuenta conectada y los que la política no deja', async () => {
    assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => getQueueBlockers(tx)), {
      outreachEnabled: true,
      channelsWithoutAccount: ['instagram_dm', 'whatsapp'],
      channelsNotAllowed: ['instagram_dm', 'whatsapp'],
    });
    await t.admin(`
      UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = '${ACC.linkedin}';
      UPDATE outbound_policy SET enabled = false WHERE workspace_id = '${WS_A}';
    `);
    try {
      assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => getQueueBlockers(tx)), {
        outreachEnabled: false,
        channelsWithoutAccount: ['linkedin', 'instagram_dm', 'whatsapp'],
        channelsNotAllowed: ['instagram_dm', 'whatsapp'],
      });
    } finally {
      await t.admin(`
        UPDATE outreach_channel_account SET status = 'connected' WHERE id = '${ACC.linkedin}';
        UPDATE outbound_policy SET enabled = true WHERE workspace_id = '${WS_A}';
      `);
    }
    // B no tiene política ni cuentas: apagado (como el reclamo, que une la política con p.enabled) y sin ningún canal.
    assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => getQueueBlockers(tx)), {
      outreachEnabled: false,
      channelsWithoutAccount: ['email', 'linkedin', 'instagram_dm', 'whatsapp'],
      channelsNotAllowed: [],
    });
  });
});

describe('las páginas de la cola y del historial (cursor)', () => {
  /** Todas las páginas de una pestaña, siguiendo el cursor «siguiente» desde la primera. */
  async function pages(ws: string, bucket: 'queue' | 'history', limit?: number) {
    const out: QueuePage[] = [];
    let cursor: { direction: 'next'; token: string } | null = null;
    for (let i = 0; i < 20; i++) {
      const page: QueuePage = await t.db.withWorkspace(ws, (tx) => listOutboundQueue(tx, { bucket, limit, cursor }));
      out.push(page);
      if (!page.next) break;
      cursor = { direction: 'next', token: page.next };
    }
    return out;
  }

  test('de dos en dos, la cola y el historial se recorren enteros, sin repetir ni saltar, y «anterior» vuelve a la página de antes', async () => {
    for (const bucket of ['queue', 'history'] as const) {
      const todo = (await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket }))).rows.map((r) => r.touchId);
      const paginas = await pages(WS_A, bucket, 2);
      const ids = paginas.flatMap((p) => p.rows.map((r) => r.touchId));
      assert.deepEqual(ids, todo, `${bucket}: el mismo orden que la lista entera`);
      assert.equal(new Set(ids).size, ids.length, `${bucket}: ninguna fila dos veces`);
      assert.ok(paginas.slice(0, -1).every((p) => p.rows.length === 2), `${bucket}: páginas llenas hasta la última`);
      assert.equal(paginas[0]!.prev, null, 'la primera no tiene anterior');
      const atras = await t.db.withWorkspace(WS_A, (tx) =>
        listOutboundQueue(tx, { bucket, limit: 2, cursor: { direction: 'prev', token: paginas[2]!.prev! } }));
      assert.deepEqual(atras.rows.map((r) => r.touchId), paginas[1]!.rows.map((r) => r.touchId), `${bucket}: anterior de la 3 es la 2`);
      assert.equal(atras.next, paginas[1]!.next);
      const primera = await t.db.withWorkspace(WS_A, (tx) =>
        listOutboundQueue(tx, { bucket, limit: 2, cursor: { direction: 'prev', token: paginas[1]!.prev! } }));
      assert.deepEqual([primera.rows.map((r) => r.touchId), primera.prev], [paginas[0]!.rows.map((r) => r.touchId), null]);
    }
  });

  test('un cursor que no es de esta pestaña, o que no se entiende, empieza por la primera página', async () => {
    const primera = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'history', limit: 2 }));
    for (const token of ['nada', `${new Date().toISOString()}_${id('7a')}`, `0_infinity_${id('7a')}`, `1_2026-09-25T10:00:00.000000Z_x`]) {
      const p = await t.db.withWorkspace(WS_A, (tx) => listOutboundQueue(tx, { bucket: 'history', limit: 2, cursor: { direction: 'next', token } }));
      assert.deepEqual(p.rows.map((r) => r.touchId), primera.rows.map((r) => r.touchId), token);
    }
    assert.equal(parseQueueCursor('queue', `0_infinity_${id('7a')}`)?.at, 'infinity');
    assert.equal(parseQueueCursor('history', `0_infinity_${id('7a')}`), null);
  });

  test('205 envíos, con horas repetidas: cinco páginas de 50, sin repetir ninguno', async () => {
    const WS_C = id('c');
    const CO_C = id('c0c');
    // Tres envíos por minuto: el cursor desempata por touch_id cuando la hora es la misma.
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_C}', 'actividad-c', 'Actividad C', '${TZ}');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO_C}', 'Marca C', '${WS_C}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_C}', '${CO_C}');
      INSERT INTO outbound_touch (id, workspace_id, company_id, channel, subject, body, status, sent_at, recipient_address,
                                  provider_message_id, status_changed_at)
      SELECT ('00000065-0000-4000-8000-' || lpad(to_hex(1000 + g), 12, '0'))::uuid, '${WS_C}', '${CO_C}', 'email', 'Envío ' || g, 'Hola.',
             'sent', date_trunc('minute', now()) - (g / 3) * interval '1 minute', 'c' || g || '@marca-c.test', 'prov-c-' || g,
             date_trunc('minute', now()) - (g / 3) * interval '1 minute'
        FROM generate_series(1, 205) AS g;
    `);
    const paginas = await pages(WS_C, 'history');
    assert.deepEqual(paginas.map((p) => p.rows.length), [QUEUE_PAGE_SIZE, QUEUE_PAGE_SIZE, QUEUE_PAGE_SIZE, QUEUE_PAGE_SIZE, 5]);
    const ids = paginas.flatMap((p) => p.rows.map((r) => r.touchId));
    assert.equal(new Set(ids).size, 205, 'ninguno dos veces y ninguno fuera');
    const horas = paginas.flatMap((p) => p.rows.map((r) => r.statusChangedAt.getTime()));
    assert.ok(horas.every((h, i) => i === 0 || h <= horas[i - 1]!), 'de lo último a lo primero');
    const facets = await t.db.withWorkspace(WS_C, (tx) => getQueueFacets(tx, {}));
    assert.deepEqual(facets.counts, { queue: 0, history: 205 });
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
    assert.deepEqual([email.used, email.softLimit, email.level, email.warmingUp, email.limitedBy], [17, 16, 'near', true, 'day']);
    assert.deepEqual([email.workspaceUsed, email.workspaceLimit], [17, 80], 'el tope de correos del espacio, solo en el correo');
    assert.equal(email.providerLimit, 2000);
    assert.equal(email.history.length, 14);
    assert.equal(email.history.at(-1)!.used, 17, 'el último día es hoy');
    assert.equal(email.history.at(-4)!.used, 9, 'hace tres días');
    assert.equal(email.history.reduce((n, d) => n + d.used, 0), 26, 'la fila del workspace entero no cuenta en la cuenta');
    // LinkedIn: sin calentamiento, 25 de 25.
    assert.deepEqual(
      [linkedin.used, linkedin.hardLimit, linkedin.level, linkedin.warmingUp, linkedin.usedShare, linkedin.limitedBy],
      [25, 25, 'full', false, 1, 'day'],
    );
    assert.deepEqual([linkedin.workspaceUsed, linkedin.workspaceLimit, linkedin.offReason], [null, null, null]);
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

  test('los tres topes del reclamo: la semana de la cuenta y el día del espacio también llenan la barra', async () => {
    const hoy = `(now() AT TIME ZONE '${TZ}')::date`;
    const lunes = `${hoy} - (extract(isodow FROM ${hoy})::int - 1)`;
    // LinkedIn: 3 hoy, pero la semana ya va en su tope. El despachador no reclama nada: la barra no puede decir «con margen».
    await t.admin(`
      UPDATE outbound_counter SET count = 3 WHERE channel_account_id = '${ACC.linkedin}' AND period = 'day';
      INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
      SELECT '${WS_A}', a.id, 'week', ${lunes}, 'linkedin', l.effective_weekly
        FROM outreach_channel_account a JOIN outreach_channel_account_limits l ON l.channel_account_id = a.id WHERE a.id = '${ACC.linkedin}';
      -- Otro buzón del espacio ya mandó 62 hoy: el espacio va en 79 de sus 80.
      UPDATE outbound_counter SET count = 79 WHERE workspace_id = '${WS_A}' AND channel_account_id IS NULL AND period = 'day';
    `);
    try {
      const [email, linkedin] = await t.db.withWorkspace(WS_A, (tx) => listChannelUsage(tx));
      assert.deepEqual(
        [linkedin!.used, linkedin!.limitedBy, linkedin!.hardLimit, linkedin!.level, linkedin!.weekUsed === linkedin!.weeklyLimit],
        [3, 'week', 3, 'full', true],
      );
      // El correo: 17 de 20 en el día, pero el espacio entero ya va en 79 de 80: le queda uno.
      assert.deepEqual(
        [email!.limitedBy, email!.hardLimit, email!.softLimit, email!.level, email!.workspaceUsed, email!.workspaceLimit],
        ['workspace', 18, 15, 'near', 79, 80],
      );
    } finally {
      await t.admin(`
        UPDATE outbound_counter SET count = 25 WHERE channel_account_id = '${ACC.linkedin}' AND period = 'day';
        DELETE FROM outbound_counter WHERE channel_account_id = '${ACC.linkedin}' AND period = 'week';
        UPDATE outbound_counter SET count = 17 WHERE workspace_id = '${WS_A}' AND channel_account_id IS NULL AND period = 'day';
      `);
    }
  });

  test('sin envío: la cuenta caída o el espacio apagado es «off», nunca verde', async () => {
    await t.admin(`UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = '${ACC.linkedin}'`);
    try {
      const usage = await t.db.withWorkspace(WS_A, (tx) => listChannelUsage(tx));
      assert.deepEqual(usage.map((u) => [u.channel, u.level, u.offReason]), [['email', 'near', null], ['linkedin', 'off', 'account']]);
      await t.admin(`UPDATE outbound_policy SET enabled = false WHERE workspace_id = '${WS_A}'`);
      const apagado = await t.db.withWorkspace(WS_A, (tx) => listChannelUsage(tx));
      assert.deepEqual(apagado.map((u) => [u.level, u.offReason]), [['off', 'disabled'], ['off', 'account']]);
    } finally {
      await t.admin(`
        UPDATE outreach_channel_account SET status = 'connected' WHERE id = '${ACC.linkedin}';
        UPDATE outbound_policy SET enabled = true WHERE workspace_id = '${WS_A}';
      `);
    }
  });

  test('el tope que manda es el de menos cupo; con cupos iguales, el primero en el orden del reclamo', () => {
    const base = { used: 10, dayLimit: 20, weekUsed: 40, weeklyLimit: 100, workspaceUsed: null, workspaceLimit: null };
    assert.deepEqual(usageBinding(base), { limitedBy: 'day', hardLimit: 20 });
    assert.deepEqual(usageBinding({ ...base, weekUsed: 95 }), { limitedBy: 'week', hardLimit: 15 });
    assert.deepEqual(usageBinding({ ...base, weekUsed: 90 }), { limitedBy: 'day', hardLimit: 20 }, 'empate: el día');
    assert.deepEqual(usageBinding({ ...base, workspaceUsed: 79, workspaceLimit: 80 }), { limitedBy: 'workspace', hardLimit: 11 });
    assert.deepEqual(usageBinding({ ...base, weekUsed: 120 }), { limitedBy: 'week', hardLimit: 10 }, 'pasado el tope, nada más');
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

describe('cada rama del bloqueo del reintento, con filas reales (outbound_touch_retry_block)', () => {
  // Un espacio aparte, para no mover los números de la semana de prueba.
  const WS_D = id('d');
  const CO_D = id('c0d');
  /** Una marca pública (sin dueño), vinculada al espacio: la de la ficha compartida. */
  const CO_PUB = id('c0e');
  const SEQ_D = id('5ed');
  const SEQ_ARCH = id('5ee');
  const STEP_D = id('5ed1');
  const STEP_ARCH = id('5ee1');
  const P = {
    ok: id('dd01'), optedOut: id('dd02'), suppressed: id('dd03'), invalid: id('dd04'), replied: id('dd05'), unsubscribed: id('dd06'),
    bounced: id('dd07'), archived: id('dd08'), pub: id('dd09'),
  };
  const E = { ok: id('ed01'), replied: id('ed05'), unsubscribed: id('ed06'), bounced: id('ed07'), archived: id('ed08'), pub: id('ed09') };
  /** Un fallido por rama, y el que sí se puede reintentar. */
  const F = {
    ok: id('fd01'), optedOut: id('fd02'), suppressed: id('fd03'), invalid: id('fd04'), replied: id('fd05'), unsubscribed: id('fd06'),
    bounced: id('fd07'), archived: id('fd08'), pub: id('fd09'), pubLinkedin: id('fd10'),
  };
  /** Lo que la base dice de cada uno, y lo que responde el reintento. */
  const ESPERADO: Record<string, string> = {
    [F.optedOut]: 'opted_out',
    [F.suppressed]: 'opted_out',
    [F.pub]: 'opted_out',
    [F.pubLinkedin]: 'opted_out',
    [F.invalid]: 'email_invalid',
    [F.archived]: 'sequence_archived',
    [F.replied]: 'enrollment_closed',
    [F.unsubscribed]: 'enrollment_closed',
    [F.bounced]: 'enrollment_closed',
  };

  before(async () => {
    const fallido = (tid: string, contactId: string, email: string, opts: { seq?: string; step?: string; enr?: string; channel?: string } = {}) => {
      const channel = opts.channel ?? 'email';
      return `('${tid}', '${WS_D}', '${contactId === P.pub ? CO_PUB : CO_D}', '${contactId}', ${q(opts.seq)}, ${q(opts.enr)}, ${q(opts.step)},
        '${channel}', 'Hola', 'failed', 'rejected', 1, ${q(channel === 'email' ? email : `li-${email}`)}, now() - interval '1 day',
        now() - interval '1 hour')`;
    };
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_D}', 'actividad-d', 'Actividad D', '${TZ}');
      INSERT INTO outbound_policy (workspace_id, postal_address, enabled, send_window_start, send_window_end)
      VALUES ('${WS_D}', 'Calle 93 # 11-26, Bogotá', true, '08:00', '18:00');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO_D}', 'Marca D', '${WS_D}'), ('${CO_PUB}', 'Marca pública', NULL);
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_D}', '${CO_D}'), ('${WS_D}', '${CO_PUB}');
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
        ('${P.ok}', '${CO_D}', '${WS_D}', 'Ok', 'ok@marca-d.test', 'user_provided'),
        ('${P.optedOut}', '${CO_D}', '${WS_D}', 'Se dio de baja', 'baja@marca-d.test', 'user_provided'),
        ('${P.suppressed}', '${CO_D}', '${WS_D}', 'En la lista global', 'global@marca-d.test', 'user_provided'),
        ('${P.invalid}', '${CO_D}', '${WS_D}', 'Rebotó', 'rebote@marca-d.test', 'user_provided'),
        ('${P.replied}', '${CO_D}', '${WS_D}', 'Respondió', 'respondio@marca-d.test', 'user_provided'),
        ('${P.unsubscribed}', '${CO_D}', '${WS_D}', 'Baja en la cadencia', 'cadencia@marca-d.test', 'user_provided'),
        ('${P.bounced}', '${CO_D}', '${WS_D}', 'Rebote en la cadencia', 'rebote-cadencia@marca-d.test', 'user_provided'),
        ('${P.archived}', '${CO_D}', '${WS_D}', 'Archivada', 'archivada@marca-d.test', 'user_provided');
      INSERT INTO contact (id, company_id, full_name, email, source, source_url, owner_workspace_id) VALUES
        ('${P.pub}', '${CO_PUB}', 'Prensa', 'prensa@marca-publica.test', 'public_website', 'https://marca-publica.test/prensa', NULL);
      INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES
        ('${SEQ_D}', '${WS_D}', 'La de D', 'email', 'active'), ('${SEQ_ARCH}', '${WS_D}', 'Archivada', 'email', 'active');
      INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, body_template)
      VALUES ('${STEP_D}', '${WS_D}', '${SEQ_D}', 0, 0, 'email', 'email', '10:00', 'Hola'),
             ('${STEP_ARCH}', '${WS_D}', '${SEQ_ARCH}', 0, 0, 'email', 'email', '10:00', 'Hola');
      INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status, finished_at) VALUES
        ('${E.ok}', '${WS_D}', '${SEQ_D}', '${P.ok}', 'active', NULL),
        ('${E.replied}', '${WS_D}', '${SEQ_D}', '${P.replied}', 'replied', now()),
        ('${E.unsubscribed}', '${WS_D}', '${SEQ_D}', '${P.unsubscribed}', 'opted_out', now()),
        ('${E.bounced}', '${WS_D}', '${SEQ_D}', '${P.bounced}', 'bounced', now()),
        ('${E.archived}', '${WS_D}', '${SEQ_ARCH}', '${P.archived}', 'active', NULL),
        ('${E.pub}', '${WS_D}', '${SEQ_D}', '${P.pub}', 'active', NULL);
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, enrollment_id, step_id, channel, body, status,
                                  blocked_reason, attempt_count, recipient_address, scheduled_for, status_changed_at)
      VALUES ${[
        fallido(F.ok, P.ok, 'ok@marca-d.test', { seq: SEQ_D, enr: E.ok, step: STEP_D }),
        fallido(F.optedOut, P.optedOut, 'baja@marca-d.test'),
        fallido(F.suppressed, P.suppressed, 'global@marca-d.test'),
        fallido(F.invalid, P.invalid, 'rebote@marca-d.test'),
        fallido(F.replied, P.replied, 'respondio@marca-d.test', { seq: SEQ_D, enr: E.replied, step: STEP_D }),
        fallido(F.unsubscribed, P.unsubscribed, 'cadencia@marca-d.test', { seq: SEQ_D, enr: E.unsubscribed, step: STEP_D }),
        fallido(F.bounced, P.bounced, 'rebote-cadencia@marca-d.test', { seq: SEQ_D, enr: E.bounced, step: STEP_D }),
        fallido(F.archived, P.archived, 'archivada@marca-d.test', { seq: SEQ_ARCH, enr: E.archived, step: STEP_ARCH }),
        fallido(F.pub, P.pub, 'prensa@marca-publica.test', { seq: SEQ_D, enr: E.pub, step: STEP_D }),
        // La baja por enlace es de todos los canales: el LinkedIn de la misma ficha tampoco vuelve.
        fallido(F.pubLinkedin, P.pub, 'prensa', { channel: 'linkedin' }),
      ].join(',\n')};
      -- Lo que cambia después de fallar: la ficha, la lista global, el rebote, la cadencia archivada y el enlace de baja.
      UPDATE contact SET opted_out = true WHERE id = '${P.optedOut}';
      INSERT INTO contact_suppression (email, reason) VALUES ('global@marca-d.test', 'complaint');
      UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = 'bounced' WHERE id = '${P.invalid}';
      UPDATE outbound_sequence SET status = 'archived' WHERE id = '${SEQ_ARCH}';
      -- La ficha pública compartida: el enlace la saca de ESTE espacio y no toca contact.opted_out (0055 §8.1).
      INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash) VALUES ('${WS_D}', 'prensa@marca-publica.test', repeat('d', 64));
    `);
  }, SETUP_TIMEOUT);

  test('la vista dice por qué no vuelve cada uno, y los botones por tipo solo cuentan el que puede', async () => {
    const { rows } = await t.db.withWorkspace(WS_D, (tx) => listOutboundQueue(tx, { bucket: 'queue', statuses: ['failed'] }));
    const byId = new Map(rows.map((r) => [r.touchId, r]));
    assert.equal(rows.length, 10);
    for (const [tid, code] of Object.entries(ESPERADO)) {
      assert.deepEqual([byId.get(tid)!.retryBlock, byId.get(tid)!.retryable], [code, false], `${tid}: ${code}`);
    }
    assert.deepEqual([byId.get(F.ok)!.retryBlock, byId.get(F.ok)!.retryable], [null, true]);
    assert.equal(await t.db.asWorker(async (tx) => (await tx.query<{ o: boolean }>(
      `SELECT opted_out AS o FROM contact WHERE id = $1`, [P.pub],
    )).rows[0]!.o), false, 'la ficha compartida no está dada de baja para nadie más');
    // Seis fallidos de correo con paso: solo cuenta el que la base deja volver. Un «Correo · 6» sería un botón que no hace nada.
    const facets = await t.db.withWorkspace(WS_D, (tx) => getQueueFacets(tx, {}));
    assert.deepEqual(facets.retryableByStepType, [{ stepType: 'email', count: 1 }]);
  });

  test('las mismas ramas sobre el toque suelto de A, cambiado en memoria (jsonb_populate_record)', async () => {
    await t.admin(`
      INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash) VALUES ('${WS_A}', 'fuera@marca.test', repeat('e', 64));
      UPDATE outbound_sequence SET status = 'archived' WHERE id = '${SEQ_B}';
    `);
    try {
      const block = (overrides: Record<string, unknown>) => t.db.asWorker(async (tx) => (await tx.query<{ b: string | null }>(
        `SELECT outbound_touch_retry_block(jsonb_populate_record(t, $2::jsonb)) AS b FROM outbound_touch t WHERE t.id = $1`,
        [id('7a'), JSON.stringify({ status: 'failed', blocked_reason: 'rejected', ...overrides })],
      )).rows[0]!.b);
      assert.equal(await block({}), null, 'el de control');
      assert.equal(await block({ contact_id: contact(5) }), 'email_invalid', 'correo a una ficha que rebotó');
      assert.equal(await block({ contact_id: contact(5), channel: 'linkedin', recipient_address: 'li-c5' }), null,
        'el rebote del correo no frena el LinkedIn');
      assert.equal(await block({ recipient_address: 'fuera@marca.test' }), 'opted_out', 'la dirección del envío en la baja del espacio');
      assert.equal(await block({ workspace_id: WS_B, recipient_address: 'fuera@marca.test' }), null, 'la baja es solo de ese espacio');
      assert.equal(await block({ sequence_id: SEQ_B }), 'sequence_archived');
      for (const n of [1, 2, 4]) assert.equal(await block({ enrollment_id: enrollment(n) }), 'enrollment_closed', `replied (c${n})`);
    } finally {
      await t.admin(`
        DELETE FROM outbound_workspace_optout WHERE workspace_id = '${WS_A}' AND email = 'fuera@marca.test';
        UPDATE outbound_sequence SET status = 'active' WHERE id = '${SEQ_B}';
      `);
    }
  });

  test('el reintento responde con el mismo código que la vista, sin tocar ninguno', async () => {
    const ids = Object.keys(ESPERADO);
    const report = await t.db.withWorkspace(WS_D, (tx) => retryFailedTouches(tx, { touchIds: ids }));
    assert.deepEqual(report.done, []);
    assert.deepEqual(Object.fromEntries(report.skipped.map((s) => [s.touchId, s.code])), ESPERADO);
    const estados = await t.db.asWorker(async (tx) => (await tx.query<{ status: string }>(
      `SELECT DISTINCT status FROM outbound_touch WHERE id = ANY($1::uuid[])`, [ids],
    )).rows.map((r) => r.status));
    assert.deepEqual(estados, ['failed']);
  });

  test('reintentar por tipo de paso devuelve a scheduled el fallido que puede, con los filtros de la pantalla, y deja los bloqueados', async () => {
    const estado = async (ids: string[]) => t.db.asWorker(async (tx) => (await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM outbound_touch WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids],
    )).rows.map((r) => [r.id, r.status]));
    const bloqueados = Object.keys(ESPERADO);
    try {
      // Un contacto que no casa con nadie: la consulta con los filtros de la vista corre y no mueve nada.
      const nadie = await t.db.withWorkspace(WS_D, (tx) => retryFailedTouches(tx, { stepType: 'email', contact: 'nadie' }));
      assert.deepEqual(nadie, { done: [], skipped: [] });
      // Otra cadencia (la archivada): tampoco, aunque sea del mismo tipo.
      const otra = await t.db.withWorkspace(WS_D, (tx) => retryFailedTouches(tx, { stepType: 'email', sequenceId: SEQ_ARCH }));
      assert.deepEqual(otra, { done: [], skipped: [] });
      assert.deepEqual((await estado([F.ok])).map(([, s]) => s), ['failed']);
      // «Correo · 1»: el único fallido de correo que la base deja volver.
      const report = await t.db.withWorkspace(WS_D, (tx) =>
        retryFailedTouches(tx, { stepType: 'email', sequenceId: SEQ_D, contact: 'ok@marca-d' }));
      assert.deepEqual(report, { done: [F.ok], skipped: [] });
      const { rows } = await t.db.withWorkspace(WS_D, (tx) => listOutboundQueue(tx, { bucket: 'queue', statuses: ['scheduled'] }));
      assert.deepEqual(rows.map((r) => [r.touchId, r.status, r.reason]), [[F.ok, 'scheduled', null]], 'vuelve a la cola, sin el motivo viejo');
      // Y los bloqueados siguen fallidos, uno por uno.
      assert.deepEqual(new Set((await estado(bloqueados)).map(([, s]) => s)), new Set(['failed']));
      // Sin filtros, ya no queda nada de correo que reintentar.
      assert.deepEqual(await t.db.withWorkspace(WS_D, (tx) => retryFailedTouches(tx, { stepType: 'email' })), { done: [], skipped: [] });
    } finally {
      // El de control vuelve a fallar, para la prueba del viernes.
      await t.admin(`UPDATE outbound_touch SET status = 'failed', blocked_reason = 'rejected' WHERE id = '${F.ok}'`);
    }
  });

  test('un reintento un viernes a las 20:00 sale el lunes al abrir la ventana del espacio, no «ahora»', async () => {
    // Viernes 25 de septiembre de 2026, 20:00 en Bogotá (UTC-5): fuera de la ventana de 08:00 a 18:00.
    const viernes = new Date('2026-09-26T01:00:00.000Z');
    const report = await t.db.withWorkspace(WS_D, (tx) => retryFailedTouches(tx, { touchIds: [F.ok] }, viernes));
    assert.deepEqual(report, { done: [F.ok], skipped: [] });
    const { rows } = await t.db.withWorkspace(WS_D, (tx) => listOutboundQueue(tx, { bucket: 'queue', statuses: ['scheduled'] }));
    const fila = rows.find((r) => r.touchId === F.ok)!;
    const esperado = retryScheduledFor(F.ok, viernes, TZ, { start: '08:00', end: '18:00' });
    assert.equal(fila.dueAt!.getTime(), esperado.getTime(), 'la hora de la fila es la del reclamo');
    assert.equal(fila.retrying, false);
    // El lunes 28, entre las 08:00 y las 08:30 de Bogotá (la dispersión de la apertura, la misma semilla que el reclamo).
    const lunes = Date.parse('2026-09-28T13:00:00.000Z');
    assert.ok(fila.dueAt!.getTime() >= lunes && fila.dueAt!.getTime() < lunes + 30 * 60_000, fila.dueAt!.toISOString());
    // Dentro de la ventana, sale ya.
    const martes = new Date('2026-09-29T15:00:00.000Z');
    assert.equal(retryScheduledFor(F.ok, martes, TZ, { start: '08:00', end: '18:00' }).getTime(), martes.getTime());
  });
});

describe('la base también dice quién opera la cola (0072 §6, pulido r1)', () => {
  const WS_G = id('a6');
  const CO_G = id('c06');
  const P_G = id('d06');
  const PROG = id('7a61');
  const FALLO = id('7a62');
  const DUENA = id('0d1');
  const LECTORA = id('0d2');
  const CLIENTE = id('0d3');
  const MIEMBRO = id('0d4');
  const como = <T>(userId: string, fn: Parameters<typeof t.db.withWorkspace<T>>[1]) => t.db.withWorkspace(WS_G, fn, { userId });
  const estado = async () =>
    (await t.db.asWorker((tx) => tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM outbound_touch WHERE id IN ('${PROG}', '${FALLO}') ORDER BY id`,
    ))).rows.map((r) => r.status);

  before(async () => {
    await t.admin(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_G}', 'actividad-guardia', 'Actividad guardia', '${TZ}');
      INSERT INTO outbound_policy (workspace_id, postal_address, enabled) VALUES ('${WS_G}', 'Calle 93 # 11-26, Bogotá', true);
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO_G}', 'Marca G', '${WS_G}');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_G}', '${CO_G}');
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
      VALUES ('${P_G}', '${CO_G}', '${WS_G}', 'Gabriela', 'gabriela@marca-g.test', 'user_provided');
      INSERT INTO app_user (id, email, name) VALUES
        ('${DUENA}', 'duena@guardia.test', 'Dueña'), ('${LECTORA}', 'lectora@guardia.test', 'Lectora'),
        ('${CLIENTE}', 'cliente@guardia.test', 'Cliente'), ('${MIEMBRO}', 'miembro@guardia.test', 'Miembro');
      ${membershipSql([
        { workspaceId: WS_G, userId: DUENA, kind: 'owner' }, { workspaceId: WS_G, userId: LECTORA, kind: 'viewer' },
        { workspaceId: WS_G, userId: CLIENTE, kind: 'client' }, { workspaceId: WS_G, userId: MIEMBRO, kind: 'member' },
      ])}
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for,
                                  blocked_reason, attempt_count, recipient_address)
      VALUES ('${PROG}', '${WS_G}', '${CO_G}', '${P_G}', 'email', 'Hola', 'Una idea.', 'scheduled', now() + interval '1 day', NULL, 0, NULL),
             ('${FALLO}', '${WS_G}', '${CO_G}', '${P_G}', 'email', 'Hola', 'Otra idea.', 'failed', now() - interval '1 day', 'rejected', 1,
              'gabriela@marca-g.test');
    `);
  });

  test("un 'viewer' o un 'client' no cancelan ni reintentan, ni por la función ni con un UPDATE a mano: 42501", async () => {
    const denegado = (e: unknown) => (e as { code?: string }).code === '42501';
    for (const quien of [LECTORA, CLIENTE]) {
      await assert.rejects(como(quien, (tx) => cancelQueuedTouches(tx, [PROG])), denegado);
      await assert.rejects(como(quien, (tx) => retryFailedTouches(tx, { touchIds: [FALLO] })), denegado);
      await assert.rejects(
        como(quien, (tx) => tx.query(`UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'canceled_by_user' WHERE id = '${PROG}'`)),
        denegado,
      );
    }
    assert.deepEqual(await estado(), ['scheduled', 'failed'], 'nada se movió');
  });

  test("quien opera ('member', 'owner') sí; y la web sin identidad y el worker, como siempre", async () => {
    assert.deepEqual((await como(MIEMBRO, (tx) => retryFailedTouches(tx, { touchIds: [FALLO] }))).done, [FALLO]);
    assert.deepEqual((await como(DUENA, (tx) => cancelQueuedTouches(tx, [PROG]))).done, [PROG]);
    assert.deepEqual(await estado(), ['canceled', 'scheduled']);
    // Sin identidad (desarrollo sin Supabase Auth, pruebas) y el worker no pasan por la guardia.
    assert.deepEqual((await t.db.withWorkspace(WS_G, (tx) => cancelQueuedTouches(tx, [FALLO]))).done, [FALLO]);
    await t.db.asWorker((tx) => tx.query(`UPDATE outbound_touch SET status = 'failed', blocked_reason = 'rejected' WHERE id = '${FALLO}'`));
    await t.db.asWorker((tx) => tx.query(`UPDATE outbound_touch SET status = 'canceled' WHERE id = '${FALLO}'`));
    assert.deepEqual(await estado(), ['canceled', 'canceled']);
  });
});
