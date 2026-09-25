/**
 * VEN-12 · la generación con afirmaciones trazables, de punta a punta
 * sobre el seed del repositorio en Postgres embebido, como mc_worker. Sin
 * red ni llave: el generador y el juez falsos, o un juez sobre un modelo
 * guionizado que devuelve tokens de verdad.
 *
 *   · dos marcas del mismo nicho (Café Alma y Fresko Market, cocina)
 *     reciben correos con similitud menor de 0,65;
 *   · el juez deja su nota, sus tokens y su costo en outbound_review, y
 *     cada llamada su fila en outbound_llm_call;
 *   · el prompt ve SOLO lo enviado antes a esa persona;
 *   · sin presupuesto no se llama al modelo; y un toque que cambió
 *     mientras se revisaba no se pisa (compuerta C).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddedDb } from '@mc/db/embedded';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { buildGenerationPrompt, loadPrompt } from '@mc/core/outreach/generate';
import { textSimilarity } from '@mc/core/outreach/gates';
import { LlmMessageJudge } from '@mc/core/outreach/judge';
import { llmCostUsd, type LlmClient, type LlmRequest } from '@mc/core/outreach/llm';
import { enrollContacts, loadGenerationContext } from '@mc/db/queries/outreach';
import { motorDbFromClient, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import { runGenerate } from '../src/jobs/ventas/outbound.generate.ts';
import { runReview } from '../src/jobs/ventas/outbound.review.ts';
import { generationInputFrom, writersFrom, type Writers } from '../src/jobs/ventas/redaccion.ts';
import { ConfigError } from '../src/runner/config.ts';
import { SETUP_TIMEOUT } from './helpers/harness.ts';

const WS = '00000002-0000-4000-8000-000000000001';
const CAMILO_CAFE_ALMA = '00000002-0000-4000-8000-0000000c0004';
const CAMILA_FRESKO = '00000002-0000-4000-8000-0000000c0001';
const JULIAN_NUTRIVE = '00000002-0000-4000-8000-0000000c0005';
const LAURA_GRANOS = '00000002-0000-4000-8000-0000000c0009';
const ANDREA_HOGAR = '00000002-0000-4000-8000-0000000c0007';

let db: EmbeddedDb;
let motor: MotorDb;
let sequenceId: string;
const fake: Writers = { mode: 'fake', generator: createFakeGenerator(), judge: createFakeJudge() };
const clock = () => new Date();
/** El generador redacta un toque el día antes de su hora: los jobs corren con el reloj una semana adelante. */
const later = () => new Date(Date.now() + 7 * 24 * 3600_000);

before(async () => {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  db = await createEmbeddedDb({ seeds: true, snapshot: true });
  motor = motorDbFromClient(db);
  sequenceId = await db.asWorker(async (tx) => {
    const seq = (await tx.query<{ id: string }>(
      `INSERT INTO outbound_sequence (workspace_id, name, channel, status, automation_mode)
       VALUES ($1, 'VEN-12 · encaje de audiencia', 'email', 'active', 'review') RETURNING id`,
      [WS],
    )).rows[0]!.id;
    await tx.query(
      `INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id,
                                  guidance_es, generate_with_ai)
       SELECT $1, $2, 0, 0, 'email', 'email', '09:30', a.id, 'Abre con la coincidencia entre tu audiencia y su cliente.', true
         FROM outbound_angle a WHERE a.workspace_id IS NULL AND a.key = 'encaje_audiencia'`,
      [WS, seq],
    );
    return seq;
  });
}, SETUP_TIMEOUT);

after(async () => {
  await db?.close();
});

/** Enrola a una persona hoy y devuelve su toque (en borrador: lo escribe el generador). */
async function enroll(contactId: string): Promise<string> {
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId, contactIds: [contactId], now: clock() }));
  assert.equal(r.enrolled.length, 1, JSON.stringify(r.skipped));
  assert.equal(r.enrolled[0]!.drafts, 1);
  return db.asWorker(async (tx) =>
    (await tx.query<{ id: string }>('SELECT id FROM outbound_touch WHERE enrollment_id = $1', [r.enrolled[0]!.enrollmentId])).rows[0]!.id,
  );
}

interface TouchRow { status: string; held_reason: string | null; subject: string | null; body: string; claims: Array<{ id: string; source: string }> }
const touch = (id: string) =>
  db.asWorker(async (tx) => (await tx.query<TouchRow>('SELECT status, held_reason, subject, body, claims FROM outbound_touch WHERE id = $1', [id])).rows[0]!);

/** Lo que haría el despachador al confirmar el envío: el mensaje queda como enviado. */
async function markSent(touchId: string, address: string): Promise<void> {
  await db.execAsSuperuser(
    `UPDATE outbound_touch SET status = 'sent', sent_at = now(), recipient_address = '${address}' WHERE id = '${touchId}'`,
  );
}

async function generateAndReview(writers: Writers) {
  const g = await runGenerate(motor, { writers, now: later, workspaceId: WS });
  const r = await runReview(motor, { writers, now: later, workspaceId: WS });
  return { g, r };
}

test('sin llave no se redacta nada, y el redactor falso no corre contra una base compartida ni en producción', async () => {
  assert.equal(writersFrom({}, { databaseUrl: null, embedded: true }), null);
  assert.equal(writersFrom({ ANTHROPIC_API_KEY: 'sk-ant-prueba' }, { databaseUrl: null })?.mode, 'anthropic');
  assert.equal(writersFrom({ OUTREACH_WRITER: 'fake' }, { databaseUrl: null, embedded: true })?.mode, 'fake');
  const supabase = 'postgresql://mc_worker.x:clave@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
  assert.throws(() => writersFrom({ OUTREACH_WRITER: 'fake' }, { databaseUrl: supabase }), ConfigError);
  assert.throws(() => writersFrom({ OUTREACH_WRITER: 'fake', NODE_ENV: 'production' }, { databaseUrl: null, embedded: true }), ConfigError);
  const r = await runGenerate(motor, { writers: null, now: clock, workspaceId: WS });
  assert.deepEqual([r.notConfigured, r.generated.length], [true, 0]);
});

test('terminado cuando: dos marcas del mismo nicho reciben correos con similitud menor de 0,65', async () => {
  const a = await enroll(CAMILO_CAFE_ALMA);
  const first = await generateAndReview(fake);
  assert.deepEqual(first.g.generated, [a]);
  // Los diez primeros de cada tipo pasan por una persona, aunque la puerta los apruebe.
  assert.deepEqual(first.r.held, [{ touchId: a, reason: 'quality_warmup' }]);
  const ta = await touch(a);
  assert.equal(ta.status, 'held');
  assert.match(ta.held_reason ?? '', /^quality_warmup:\d+$/);
  assert.ok(ta.subject && !ta.body.includes('[claim:'), 'sale sin marcas');
  assert.ok(ta.claims.length > 0 && ta.claims.every((c) => ['creator_profile', 'creator_baseline'].includes(c.source)), 'solo lo que el ángulo deja citar');
  await markSent(a, 'c.herrera@cafealma.co');

  const b = await enroll(CAMILA_FRESKO);
  await generateAndReview(fake);
  const tb = await touch(b);
  assert.equal(tb.status, 'held');
  const sim = textSimilarity(ta.body, tb.body);
  assert.ok(sim < 0.65, `similitud ${sim}`);
  const gates = await db.asWorker(async (tx) =>
    (await tx.query<{ gates: { similarity: { max: number; threshold: number } } }>('SELECT gates FROM outbound_review WHERE touch_id = $1', [b])).rows,
  );
  assert.ok(gates.length >= 1 && gates.every((x) => x.gates.similarity.max < 0.65 && x.gates.similarity.threshold === 0.8));
});

/** Un modelo guionizado: devuelve siempre la misma calificación, con tokens de verdad. */
function scriptedJudgeLlm(): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    name: 'guion', requests,
    async complete(req) {
      requests.push(req);
      const text = JSON.stringify({
        scores: { relevance: 9, quality: 8.5, structure: 9, voice: 8 }, risk_triggers: [], regenerate_hint: null,
        note: 'Abre con la marca y cita dos cifras con origen.',
      });
      return { text, model: req.model, inputTokens: 1800, outputTokens: 90, costUsd: llmCostUsd(req.model, 1800, 90), stopReason: 'end_turn' };
    },
  };
}

test('terminado cuando: el juez registra nota, tokens y costo en outbound_review, y cada llamada en outbound_llm_call', async () => {
  const llm = scriptedJudgeLlm();
  const writers: Writers = { mode: 'anthropic', generator: createFakeGenerator(), judge: new LlmMessageJudge(llm) };
  const t = await enroll(JULIAN_NUTRIVE);
  const { r } = await generateAndReview(writers);
  assert.equal(r.held.length, 1);
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0]!.model, 'claude-sonnet-5');
  const rows = await db.asWorker(async (tx) =>
    (await tx.query<{ attempt: number; decision: string; total_score: string; model: string; input_tokens: number; output_tokens: number; cost: string; scores: Record<string, number>; gates: { judge_note?: string } }>(
      'SELECT attempt, decision, total_score, model, input_tokens, output_tokens, cost, scores, gates FROM outbound_review WHERE touch_id = $1', [t],
    )).rows,
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row!.attempt, row!.decision, row!.model], [1, 'pass', 'claude-sonnet-5']);
  assert.equal(Number(row!.total_score), 8.68);
  assert.deepEqual(row!.scores, { relevance: 9, quality: 8.5, structure: 9, voice: 8 });
  assert.deepEqual([row!.input_tokens, row!.output_tokens, Number(row!.cost)], [1800, 90, 0.0045]);
  assert.equal(row!.gates.judge_note, 'Abre con la marca y cita dos cifras con origen.');
  const calls = await db.asWorker(async (tx) =>
    (await tx.query<{ purpose: string; model: string; cost: string }>('SELECT purpose, model, cost FROM outbound_llm_call WHERE touch_id = $1 ORDER BY created_at', [t])).rows,
  );
  assert.deepEqual(calls.map((c) => [c.purpose, c.model, Number(c.cost)]), [['generate', 'on-cue-fake-generator', 0], ['judge', 'claude-sonnet-5', 0.0045]]);
});

test('terminado cuando: los toques anteriores del prompt salen solo de lo enviado', async () => {
  // Cuatro mensajes anteriores a la misma persona, en cuatro estados; solo uno salió.
  await db.execAsSuperuser(`
    INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, subject, body, status, sent_at, recipient_address, held_reason, blocked_reason)
    SELECT '${WS}', c.company_id, c.id, 'email', x.subject, x.body, x.status,
           CASE WHEN x.status = 'sent' THEN now() - interval '3 days' END,
           CASE WHEN x.status = 'sent' THEN c.email END,
           CASE WHEN x.status = 'held' THEN 'needs_review' END,
           CASE WHEN x.status = 'canceled' THEN 'replied' END
      FROM contact c,
           (VALUES ('Lo que salió', 'ESTE SÍ SALIÓ: te escribí por el lanzamiento.', 'sent'),
                   ('Retenido', 'ESTE QUEDÓ RETENIDO y nunca salió.', 'held'),
                   ('Cancelado', 'ESTE SE CANCELÓ antes de salir.', 'canceled'),
                   ('Borrador', 'ESTE ES UN BORRADOR.', 'draft')) AS x(subject, body, status)
     WHERE c.id = '${ANDREA_HOGAR}'`);
  const t = await enroll(ANDREA_HOGAR);
  const ctx = await db.asWorker((tx) => loadGenerationContext(tx, t));
  const bodies = ctx.previousTouches.map((p) => p.body);
  assert.ok(bodies.includes('ESTE SÍ SALIÓ: te escribí por el lanzamiento.'));
  const statuses = await db.asWorker(async (tx) =>
    (await tx.query<{ status: string }>('SELECT DISTINCT status FROM outbound_touch WHERE body = ANY($1::text[])', [bodies])).rows.map((x) => x.status),
  );
  assert.deepEqual(statuses, ['sent'], 'todo lo que ve el prompt salió');
  const { user } = buildGenerationPrompt({ ...generationInputFrom(ctx), attempt: 1, hint: null }, loadPrompt('generate'));
  assert.ok(user.includes('ESTE SÍ SALIÓ'));
  for (const nunca of ['RETENIDO', 'SE CANCELÓ', 'BORRADOR']) assert.ok(!user.includes(nunca), nunca);
  // Y el primer contacto con cifras de la base: los claims del seed están en el prompt.
  assert.ok(ctx.claims.some((c) => c.id === 'baseline:tiktok:median_views'), JSON.stringify(ctx.claims.map((c) => c.id)));
  assert.ok(user.includes('baseline:tiktok:median_views'));
  // Deja la cola como estaba para las pruebas siguientes.
  await generateAndReview(fake);
});

test('sin presupuesto no se llama al modelo; un toque que cambió durante la revisión no se pisa (compuerta C)', async () => {
  await db.execAsSuperuser(`UPDATE outbound_policy SET llm_daily_cap_usd = 0 WHERE workspace_id = '${WS}'`);
  const t = await enroll(LAURA_GRANOS);
  const sinPlata = await runGenerate(motor, { writers: fake, now: later, workspaceId: WS });
  assert.deepEqual([sinPlata.generated, sinPlata.overBudget], [[], [t]]);
  assert.equal((await touch(t)).status, 'draft', 'el toque espera en borrador');
  await db.execAsSuperuser(`UPDATE outbound_policy SET llm_daily_cap_usd = 5 WHERE workspace_id = '${WS}'`);

  assert.deepEqual((await runGenerate(motor, { writers: fake, now: later, workspaceId: WS })).generated, [t]);
  // Mientras el juez piensa, alguien cancela el toque: el resultado no se escribe.
  const judge = createFakeJudge();
  const writers: Writers = {
    mode: 'fake', generator: createFakeGenerator(),
    judge: {
      ...judge,
      async judge(input) {
        await db.execAsSuperuser(`UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'replied' WHERE id = '${t}'`);
        return judge.judge(input);
      },
    },
  };
  const r = await runReview(motor, { writers, now: later, workspaceId: WS });
  assert.deepEqual(r.skipped, [{ touchId: t, codes: ['touch_not_draft'] }]);
  const after = await touch(t);
  assert.deepEqual([after.status, after.body], ['canceled', '']);
  const reviews = await db.asWorker(async (tx) => (await tx.query('SELECT 1 FROM outbound_review WHERE touch_id = $1', [t])).rows);
  assert.equal(reviews.length, 0);
});
