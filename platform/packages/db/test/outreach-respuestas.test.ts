/**
 * VEN-10 r4 · una respuesta deja la MISMA base llegue por el webhook de
 * Unipile (recordInboundMessage, VEN-9, con la RLS del workspace) o por
 * el lector de respuestas del motor (recordInbound, como mc_worker).
 *
 * Una prueba de tabla: cada mensaje se manda por las dos puertas, a dos
 * escenarios idénticos (una marca, su cadencia con un correo enviado, uno
 * programado y un borrador), y se compara lo que queda: el enrolamiento,
 * los toques, la ficha, la intención del mensaje y los avisos. Hasta la
 * r3 una baja en portugués por el job solo marcaba replied, el webhook
 * cancelaba los borradores y el job no, y un enrolamiento completo solo
 * pasaba a replied por el job.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTREACH_NOTICE_TEXTS } from '@mc/core/outreach/messages';
import { recordInboundMessage } from '../src/queries/canales.ts';
import { listOpenThreads, recordInbound } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const GMAIL_LAURA = '00000005-0000-4000-8000-0000000ac001';
const NOW = new Date('2026-09-24T15:00:00Z');

let t: TestDb;
before(async () => {
  t = await openTestDb();
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

const id = (n: number, kind: string) => `000010a4-${n.toString(16).padStart(4, '0')}-4000-8000-${kind.padStart(12, '0')}`;

/** Un escenario: marca, ficha, secuencia de tres pasos, enrolamiento y sus toques (enviado, programado, borrador). */
async function escenario(n: number, enrollmentStatus: 'active' | 'completed'): Promise<{ contact: string; enrollment: string; thread: string }> {
  const [company, contact, seq, enr] = [id(n, 'c0'), id(n, 'c1'), id(n, '5e'), id(n, 'e0')];
  const steps = [id(n, '5e01'), id(n, '5e02'), id(n, '5e03')];
  const thread = `hilo-r4-${n}`;
  const pendientes = enrollmentStatus === 'active';
  await t.admin(`
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${company}', 'Marca ${n}', '${WORKSPACE_LAURA}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WORKSPACE_LAURA}', '${company}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${contact}', '${company}', '${WORKSPACE_LAURA}', 'Persona ${n}', 'persona${n}@respuestas-r4.test', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
    VALUES ('${seq}', '${WORKSPACE_LAURA}', 'Respuestas ${n}', 'email', 'active', 'auto');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, subject_template, body_template)
    VALUES ('${steps[0]}', '${WORKSPACE_LAURA}', '${seq}', 0, 0, 'email', 'email', '09:30', 'Hola', 'Hola.'),
           ('${steps[1]}', '${WORKSPACE_LAURA}', '${seq}', 2, 0, 'email', 'email', '10:00', 'Sigo', 'Sigo.'),
           ('${steps[2]}', '${WORKSPACE_LAURA}', '${seq}', 4, 0, 'email', 'email', '10:00', 'Cierro', 'Cierro.');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, current_step_id, status, started_at, finished_at)
    VALUES ('${enr}', '${WORKSPACE_LAURA}', '${seq}', '${contact}', '${steps[0]}', '${enrollmentStatus}', now() - interval '3 days',
            ${pendientes ? 'NULL' : "now() - interval '1 hour'"});
    INSERT INTO outbound_touch (workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel, subject, body,
                                status, scheduled_for, claimed_at, sent_at, attempt_count, provider_message_id, thread_ref,
                                channel_account_id, recipient_address)
    VALUES ('${WORKSPACE_LAURA}', '${company}', '${contact}', '${seq}', 1, '${enr}', '${steps[0]}', 'email', 'Hola', 'Hola.', 'sent',
            now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', 1, 'enviado-r4-${n}', '${thread}',
            '${GMAIL_LAURA}', 'persona${n}@respuestas-r4.test'),
           ('${WORKSPACE_LAURA}', '${company}', '${contact}', '${seq}', 2, '${enr}', '${steps[1]}', 'email', 'Sigo', 'Sigo.',
            '${pendientes ? 'scheduled' : 'sent'}', now() + interval '1 day', NULL, ${pendientes ? 'NULL' : "now() - interval '2 days'"},
            ${pendientes ? 0 : 1}, ${pendientes ? 'NULL' : `'enviado-r4-${n}-2'`}, ${pendientes ? 'NULL' : `'${thread}'`},
            ${pendientes ? 'NULL' : `'${GMAIL_LAURA}'`}, ${pendientes ? 'NULL' : `'persona${n}@respuestas-r4.test'`}),
           ('${WORKSPACE_LAURA}', '${company}', '${contact}', '${seq}', 3, '${enr}', '${steps[2]}', 'email', 'Cierro', 'Cierro.',
            '${pendientes ? 'draft' : 'sent'}', now() + interval '3 days', NULL, ${pendientes ? 'NULL' : "now() - interval '1 day'"},
            ${pendientes ? 0 : 1}, ${pendientes ? 'NULL' : `'enviado-r4-${n}-3'`}, ${pendientes ? 'NULL' : `'${thread}'`},
            ${pendientes ? 'NULL' : `'${GMAIL_LAURA}'`}, ${pendientes ? 'NULL' : `'persona${n}@respuestas-r4.test'`});
  `);
  return { contact, enrollment: enr, thread };
}

/** Lo que queda en la base después de la respuesta, sin ids. */
async function estado(e: { contact: string; enrollment: string }, providerMessageId: string) {
  return t.db.asWorker(async (tx) => {
    const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await tx.query<T>(sql, params)).rows;
    const [enr] = await q<{ status: string; finished: boolean }>(
      `SELECT status, finished_at IS NOT NULL AS finished FROM outbound_enrollment WHERE id = $1`, [e.enrollment],
    );
    const touches = await q<{ status: string; blocked_reason: string | null; replied: boolean }>(
      `SELECT status, blocked_reason, replied_at IS NOT NULL AS replied FROM outbound_touch WHERE enrollment_id = $1 ORDER BY step_index`,
      [e.enrollment],
    );
    const [contact] = await q<{ opted_out: boolean; opted_out_reason: string | null; suppressed: boolean }>(
      `SELECT opted_out, opted_out_reason, address_is_suppressed(email) AS suppressed FROM contact WHERE id = $1`, [e.contact],
    );
    const [message] = await q<{ intent: string | null; classified: boolean; tied: boolean }>(
      `SELECT intent, classified_at IS NOT NULL AS classified, touch_id IS NOT NULL AS tied FROM outbound_message
        WHERE provider_message_id = $1 AND direction = 'inbound'`,
      [providerMessageId],
    );
    const notices = await q<{ kind: string; severity: string; title_es: string }>(
      `SELECT n.kind, n.severity, n.title_es FROM notification n JOIN outbound_message m ON m.id = n.entity_id
        WHERE m.provider_message_id = $1 ORDER BY n.created_at`,
      [providerMessageId],
    );
    return { enr, touches, contact, message, notices: notices.map((x) => ({ ...x, title_es: x.title_es.replace(/Persona \d+/, 'Persona') })) };
  });
}

const CASOS: Array<{ nombre: string; body: string; status: 'active' | 'completed'; espera: { enrollment: string; optedOut: boolean } }> = [
  { nombre: 'una respuesta', body: 'Me interesa, hablemos el jueves.', status: 'active', espera: { enrollment: 'replied', optedOut: false } },
  { nombre: 'una baja en portugués', body: 'Por favor, não me escreva mais.', status: 'active', espera: { enrollment: 'opted_out', optedOut: true } },
  { nombre: 'una baja con «Sáquenme»', body: 'Sáquenme de su lista.', status: 'active', espera: { enrollment: 'opted_out', optedOut: true } },
  { nombre: 'una baja de una palabra', body: 'BAJA', status: 'active', espera: { enrollment: 'opted_out', optedOut: true } },
  { nombre: 'la respuesta a una cadencia completa', body: 'Perdón la demora, ¿seguimos?', status: 'completed', espera: { enrollment: 'replied', optedOut: false } },
];

for (const [i, caso] of CASOS.entries()) {
  test(`${caso.nombre}: el webhook y el lector dejan la misma base`, async () => {
    const porWebhook = await escenario(2 * i + 1, caso.status);
    const porJob = await escenario(2 * i + 2, caso.status);
    const pmWebhook = `webhook-r4-${i}`;
    const pmJob = `job-r4-${i}`;

    const w = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, {
      account: { id: GMAIL_LAURA, channel: 'email' }, threadRef: porWebhook.thread, providerMessageId: pmWebhook, body: caso.body,
      fromAddress: null, occurredAt: NOW, optOutReasonEs: OUTREACH_NOTICE_TEXTS.es.optOutReason('correo'),
    }));
    assert.equal(w.inserted, true);

    const j = await t.db.asWorker(async (tx) => {
      const threads = await listOpenThreads(tx, { now: NOW, workspaceId: WORKSPACE_LAURA, limit: 2000 });
      const thread = threads.find((x) => x.threadRef === porJob.thread);
      assert.ok(thread, 'el hilo está abierto');
      return recordInbound(tx, thread, { providerMessageId: pmJob, body: caso.body, occurredAt: NOW }, NOW);
    });
    assert.equal(j.isNew, true);
    assert.equal(w.optedOut, j.optOut, 'el mismo detector');

    const a = await estado(porWebhook, pmWebhook);
    const b = await estado(porJob, pmJob);
    assert.deepEqual(a, b, 'la misma base por las dos puertas');
    assert.equal(a.enr?.status, caso.espera.enrollment);
    assert.equal(a.contact?.opted_out, caso.espera.optedOut);
    if (caso.espera.optedOut) {
      assert.equal(a.message?.intent, 'unsubscribe');
      // contact_suppression es solo para lo verificable por la plataforma
      // (enlace de baja, rebote duro, queja: 0029 §1); la baja por respuesta
      // queda en contact.opted_out de las fichas con ese correo.
      assert.equal(a.contact?.suppressed, false);
    }
    if (caso.status === 'active') {
      // Lo cancelable (programado y borrador) se cancela; lo enviado queda.
      assert.deepEqual(a.touches.map((x) => x.status), ['sent', 'canceled', 'canceled']);
    }
  });
}

// ---------------------------------------------------------------------
// r5 · la baja se queda en el workspace del mensaje, por las dos puertas
// ---------------------------------------------------------------------

const WS_OTRO = '000010a4-ffff-4000-8000-00000000000b';

/** En otro workspace, una ficha con el MISMO correo que la del escenario n, con su cadencia y un mensaje programado. */
async function fichaAjena(n: number): Promise<{ contact: string; touch: string; enrollment: string }> {
  const [company, contact, seq, enr, touch] = [id(n, 'bc0'), id(n, 'bc1'), id(n, 'b5e'), id(n, 'be0'), id(n, 'b70')];
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_OTRO}', 'respuestas-r5-otro', 'Otra creadora', 'America/Bogota')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${company}', 'Marca ${n} (otra)', '${WS_OTRO}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_OTRO}', '${company}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${contact}', '${company}', '${WS_OTRO}', 'Persona ${n}', 'persona${n}@respuestas-r4.test', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${seq}', '${WS_OTRO}', 'Otra', 'email', 'active');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status, started_at)
    VALUES ('${enr}', '${WS_OTRO}', '${seq}', '${contact}', 'active', now());
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, channel, subject, body, status, scheduled_for)
    VALUES ('${touch}', '${WS_OTRO}', '${company}', '${contact}', '${seq}', 1, '${enr}', 'email', 'Hola', 'Hola.', 'scheduled', now() + interval '1 day');
  `);
  return { contact, touch, enrollment: enr };
}

test('una baja por respuesta no toca la ficha de otro workspace con el mismo correo, ni por el webhook ni por el lector (r5)', async () => {
  const porWebhook = await escenario(21, 'active');
  const porJob = await escenario(22, 'active');
  const ajenaW = await fichaAjena(21);
  const ajenaJ = await fichaAjena(22);

  await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, {
    account: { id: GMAIL_LAURA, channel: 'email' }, threadRef: porWebhook.thread, providerMessageId: 'webhook-r5', body: 'Sáquenme de su lista.',
    fromAddress: null, occurredAt: NOW, optOutReasonEs: OUTREACH_NOTICE_TEXTS.es.optOutReason('correo'),
  }));
  await t.db.asWorker(async (tx) => {
    const threads = await listOpenThreads(tx, { now: NOW, workspaceId: WORKSPACE_LAURA, limit: 2000 });
    const thread = threads.find((x) => x.threadRef === porJob.thread)!;
    return recordInbound(tx, thread, { providerMessageId: 'job-r5', body: 'Sáquenme de su lista.', occurredAt: NOW }, NOW);
  });

  const estadoAjeno = (a: { contact: string; touch: string; enrollment: string }) =>
    t.db.asWorker(async (tx) => (await tx.query<{ opted_out: boolean; touch: string; enr: string }>(
      `SELECT c.opted_out, (SELECT status FROM outbound_touch WHERE id = $2) AS touch, (SELECT status FROM outbound_enrollment WHERE id = $3) AS enr
         FROM contact c WHERE c.id = $1`, [a.contact, a.touch, a.enrollment],
    )).rows[0]!);
  for (const ajena of [ajenaW, ajenaJ]) {
    assert.deepEqual({ ...(await estadoAjeno(ajena)) }, { opted_out: false, touch: 'scheduled', enr: 'active' }, 'la otra creadora no se entera');
  }
  const [a, b] = [await estado(porWebhook, 'webhook-r5'), await estado(porJob, 'job-r5')];
  assert.deepEqual(a, b, 'la misma base por las dos puertas');
  assert.equal(a.contact?.opted_out, true, 'la ficha del workspace del mensaje sí');
  assert.equal(a.enr?.status, 'opted_out');
  assert.match(a.notices[0]?.title_es ?? '', /pidió no recibir más mensajes/);
});
