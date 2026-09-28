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
 *
 * Ronda 2: la fila de outbound_review dice lo que costó escribir Y juzgar
 * el intento; lo que una persona escribe en el editor (o por cualquier
 * otro camino) mientras la IA trabaja manda; no se gasta en quien tiene
 * el correo rebotado; «Redactar con IA» y «Más corto» desde el editor
 * llegan al worker con sus instrucciones y su versión anterior, y el
 * toque vuelve a la persona; y el motor rellena las doce variables.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddedDb } from '@mc/db/embedded';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { buildGenerationPrompt, loadPrompt, type GenerationInput, type MessageGenerator } from '@mc/core/outreach/generate';
import { textSimilarity } from '@mc/core/outreach/gates';
import { LlmMessageJudge } from '@mc/core/outreach/judge';
import type { LlmClient, LlmRequest } from '@mc/core/outreach/llm';
import { llmCostUsd } from '@mc/core/outreach/llm-precios';
import { TEMPLATE_VARIABLES } from '@mc/core/outreach/render';
import { enrollContacts, loadGenerationContext, loadPitchComposer, requestPitchDraft, savePitch } from '@mc/db/queries/outreach';
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
const VALENTINA_CAFE_ALMA = '00000002-0000-4000-8000-0000000c0003';
/** Una persona que el seed no tiene: se crea en la prueba de la baja. */
const PEDRO_VITALE = '00000612-0000-4000-8000-0000000c0e01';
const DANIEL_SABORES = '00000002-0000-4000-8000-0000000c0008';
/** Otra persona que el seed no tiene: pulsa el enlace de baja de este espacio. */
const MARTA_VITALE = '00000612-0000-4000-8000-0000000c0e02';
const SOFIA_VITALE = '00000002-0000-4000-8000-0000000c0011';
const CAROLINA_OLLA = '00000002-0000-4000-8000-0000000c0012';
const VITALE = '00000002-0000-4000-8000-0000000000e7';
const OLLA_FACIL = '00000002-0000-4000-8000-0000000000e8';
/** El negocio de Café Alma que salió de una señal y tiene la cotización COT-2026-003 aceptada (seeds 0002 y 0004). */
const DEAL_CAFE_ALMA = '00000002-0000-4000-8000-0000000dea11';

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

/** Una persona nueva en una empresa del seed. */
async function newContact(id: string, companyId: string, fullName: string, email: string): Promise<void> {
  await db.execAsSuperuser(
    `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, role_title, email, source)
     VALUES ('${id}', '${companyId}', '${WS}', '${fullName}', 'Mercadeo', '${email}', 'user_provided')`,
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

// Ronda 4: el calentamiento cuenta solo lo que redactó la IA.
const PANADERIA = '00000612-0000-4000-8000-0000000000f1';
const LUCIA_PANADERIA = '00000612-0000-4000-8000-0000000c0e03';

test('el calentamiento cuenta solo lo redactado por la IA: con diez correos a mano ya enviados, el primero generado sigue retenido', async () => {
  await db.execAsSuperuser(`
    INSERT INTO company (id, name, domain, owner_workspace_id) VALUES ('${PANADERIA}', 'Panadería La Espiga', 'laespiga.test', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${PANADERIA}') ON CONFLICT DO NOTHING;
  `);
  // Diez correos que salieron sin la IA: cinco pitch escritos a mano (outcome 'manual') y cinco de plantilla fija (sin fila de generación).
  const manual = await db.asWorker(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = (await tx.query<{ id: string }>(
        `INSERT INTO outbound_touch (workspace_id, company_id, channel, subject, body, status, sent_at, recipient_address)
         VALUES ($1, $2, 'email', $3, $4, 'sent', now() - make_interval(days => $5::int + 1), 'compras@laespiga.test') RETURNING id`,
        [WS, PANADERIA, `Correo a mano ${i + 1}`, `Hola, este es el correo a mano número ${i + 1} con su propia historia.`, i],
      )).rows[0]!.id;
      if (i < 5) {
        await tx.query(
          `INSERT INTO outbound_generation (touch_id, workspace_id, stage, outcome, subject, body_marked, reviewed_at)
           VALUES ($1, $2, 'reviewed', 'manual', 'Correo a mano', 'Hola, escrito a mano.', now())`,
          [id, WS],
        );
      }
      ids.push(id);
    }
    return ids;
  });
  assert.equal(manual.length, 10);
  await newContact(LUCIA_PANADERIA, PANADERIA, 'Lucía Pardo', 'lucia@laespiga.test');
  const t = await enroll(LUCIA_PANADERIA);
  const { g, r } = await generateAndReview(fake);
  assert.deepEqual(g.generated, [t]);
  assert.deepEqual(r.held, [{ touchId: t, reason: 'quality_warmup' }]);
  const row = await touch(t);
  assert.equal(row.status, 'held');
  assert.equal(row.held_reason, 'quality_warmup:0');
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
      return { text, model: req.model, inputTokens: 1800, outputTokens: 90, costUsd: Number(llmCostUsd({ model: req.model, inputTokens: 1800, outputTokens: 90 })), stopReason: 'end_turn' };
    },
  };
}

/** El generador falso, pero cobrando como un modelo de verdad: 1000 tokens de entrada, 200 de salida, medio centavo. */
function costedGenerator(): MessageGenerator {
  const fake = createFakeGenerator();
  return {
    name: 'fake', model: fake.model,
    async generate(input) {
      return { ...(await fake.generate(input)), inputTokens: 1000, outputTokens: 200, costUsd: 0.005 };
    },
  };
}

test('terminado cuando: el juez registra nota, tokens y costo en outbound_review, y cada llamada en outbound_llm_call', async () => {
  const llm = scriptedJudgeLlm();
  const writers: Writers = { mode: 'anthropic', generator: costedGenerator(), judge: new LlmMessageJudge(llm) };
  const t = await enroll(JULIAN_NUTRIVE);
  const { r } = await generateAndReview(writers);
  assert.equal(r.held.length, 1);
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0]!.model, 'claude-sonnet-5');
  const rows = await db.asWorker(async (tx) =>
    (await tx.query<{ attempt: number; decision: string; total_score: string; model: string; input_tokens: number; output_tokens: number; cost: string; scores: Record<string, number>; gates: { judge_note?: string; usage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number } | null> } }>(
      'SELECT attempt, decision, total_score, model, input_tokens, output_tokens, cost, scores, gates FROM outbound_review WHERE touch_id = $1', [t],
    )).rows,
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row!.attempt, row!.decision, row!.model], [1, 'pass', 'claude-sonnet-5']);
  assert.equal(Number(row!.total_score), 8.68);
  assert.deepEqual(row!.scores, { relevance: 9, quality: 8.5, structure: 9, voice: 8 });
  // La fila del intento dice lo que costó escribirlo (outbound.generate) y juzgarlo, con el desglose.
  assert.deepEqual([row!.input_tokens, row!.output_tokens, Number(row!.cost)], [2800, 290, 0.0095]);
  assert.deepEqual(row!.gates.usage?.generate, { model: 'on-cue-fake-generator', inputTokens: 1000, outputTokens: 200, costUsd: 0.005 });
  assert.deepEqual(row!.gates.usage?.judge, { model: 'claude-sonnet-5', inputTokens: 1800, outputTokens: 90, costUsd: 0.0045 });
  assert.equal(row!.gates.judge_note, 'Abre con la marca y cita dos cifras con origen.');
  const calls = await db.asWorker(async (tx) =>
    (await tx.query<{ purpose: string; model: string; cost: string }>('SELECT purpose, model, cost FROM outbound_llm_call WHERE touch_id = $1 ORDER BY created_at', [t])).rows,
  );
  assert.deepEqual(calls.map((c) => [c.purpose, c.model, Number(c.cost)]), [['generate', 'on-cue-fake-generator', 0.005], ['judge', 'claude-sonnet-5', 0.0045]]);
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
  // Sin presupuesto no es un fallo, pero tampoco se mira en cada corrida: espera media hora (0063).
  assert.deepEqual((await runGenerate(motor, { writers: fake, now: later, workspaceId: WS })).generated, []);
  const masTarde = () => new Date(later().getTime() + 31 * 60_000);
  assert.deepEqual((await runGenerate(motor, { writers: fake, now: masTarde, workspaceId: WS })).generated, [t]);
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

// ---------------------------------------------------------------------
// Ronda 2: lo que escribe una persona manda, la redacción que pide desde
// el editor, las doce variables del motor y nada de gasto en quien no recibe.
// ---------------------------------------------------------------------

const LOCALE = 'es-CO';
const pitchBase = { dealId: null, userId: null, locale: LOCALE };
const generationRow = (touchId: string) =>
  db.asWorker(async (tx) =>
    (await tx.query<{ stage: string; outcome: string | null; body_marked: string | null }>(
      'SELECT stage, outcome, body_marked FROM outbound_generation WHERE touch_id = $1', [touchId],
    )).rows[0],
  );

test('generar, editar a mano y revisar: el editor abre el borrador de la IA y lo que guarda la persona no se pisa', async () => {
  const t = await enroll(SOFIA_VITALE);
  assert.deepEqual((await runGenerate(motor, { writers: fake, now: later, workspaceId: WS })).generated, [t]);
  // Mientras espera al juez el toque está vacío, pero el editor abre el borrador redactado, con sus marcas.
  const c = await db.withWorkspace(WS, (tx) => loadPitchComposer(tx, VITALE, LOCALE));
  assert.equal(c.draft?.touchId, t);
  assert.equal(c.draft?.pending?.stage, 'generated');
  assert.ok(c.draft!.body.includes('[claim:'), c.draft!.body);

  const humano = 'Hola {{first_name}},\n\nEsto lo escribí yo, con mis palabras.\n\nLaura';
  const saved = await db.withWorkspace(WS, (tx) =>
    savePitch(tx, { ...pitchBase, companyId: VITALE, contactId: SOFIA_VITALE, touchId: t, subject: 'Lo escribo yo', body: humano, intent: 'draft', now: new Date() }),
  );
  assert.ok(saved.ok, JSON.stringify(saved));
  const r = await runReview(motor, { writers: fake, now: later, workspaceId: WS });
  assert.ok(![...r.scheduled, ...r.returned, ...r.held.map((h) => h.touchId)].includes(t), JSON.stringify(r));
  const after = await touch(t);
  assert.deepEqual([after.status, after.subject, after.body], ['draft', 'Lo escribo yo', 'Hola Sofía,\n\nEsto lo escribí yo, con mis palabras.\n\nLaura']);
  // El marcado guarda las variables tal cual (0063): si cambia «Para», el saludo cambia con la persona.
  assert.deepEqual(await generationRow(t), { stage: 'reviewed', outcome: 'manual', body_marked: humano });
});

test('si alguien escribe en el toque mientras el juez piensa, la compuerta C lo ve (edited_by_person) y no escribe encima', async () => {
  const t = await enroll(DANIEL_SABORES);
  assert.deepEqual((await runGenerate(motor, { writers: fake, now: later, workspaceId: WS })).generated, [t]);
  const judge = createFakeJudge();
  const writers: Writers = {
    mode: 'fake', generator: createFakeGenerator(),
    judge: {
      ...judge,
      async judge(input) {
        await db.execAsSuperuser(`UPDATE outbound_touch SET body = 'Texto de una persona.' WHERE id = '${t}'`);
        return judge.judge(input);
      },
    },
  };
  const r = await runReview(motor, { writers, now: later, workspaceId: WS });
  assert.deepEqual(r.skipped, [{ touchId: t, codes: ['edited_by_person'] }]);
  assert.deepEqual([(await touch(t)).status, (await touch(t)).body], ['draft', 'Texto de una persona.']);
  // Y la siguiente corrida tampoco lo toma: el cuerpo ya no es el que había al generarlo.
  const otra = await runReview(motor, { writers: fake, now: later, workspaceId: WS });
  assert.ok(!otra.skipped.some((s) => s.touchId === t) && !otra.held.some((h) => h.touchId === t));
  assert.equal((await touch(t)).body, 'Texto de una persona.');
});

test('no se redacta (ni se gasta) para quien tiene el correo rebotado o pidió la baja', async () => {
  await db.execAsSuperuser(
    `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, role_title, email, source)
     VALUES ('${PEDRO_VITALE}', '${VITALE}', '${WS}', 'Pedro Ríos', 'Mercadeo', 'pedro.rios@vitale.co', 'user_provided')`,
  );
  const t = await enroll(PEDRO_VITALE);
  // Rebota después de enrolarse: el barrido de outbound.bounces todavía no canceló su borrador.
  await db.execAsSuperuser(
    `UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = '550 5.1.1 no existe' WHERE id = '${PEDRO_VITALE}'`,
  );
  assert.equal((await touch(t)).status, 'draft');
  const g = await runGenerate(motor, { writers: fake, now: later, workspaceId: WS });
  assert.ok(!g.generated.includes(t));
  assert.equal(await generationRow(t), undefined);
  const calls = await db.asWorker(async (tx) => (await tx.query('SELECT 1 FROM outbound_llm_call WHERE touch_id = $1', [t])).rows);
  assert.equal(calls.length, 0);

  // La baja de ESTE espacio (el enlace de baja de un correo, 0055) cuenta igual, en la cadencia y en lo que pide una persona.
  await newContact(MARTA_VITALE, VITALE, 'Marta Gil', 'marta.gil@vitale.co');
  const m = await enroll(MARTA_VITALE);
  await db.execAsSuperuser(
    `INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash) VALUES ('${WS}', 'marta.gil@vitale.co', repeat('a', 64))`,
  );
  const g2 = await runGenerate(motor, { writers: fake, now: later, workspaceId: WS });
  assert.ok(!g2.generated.includes(m));
  assert.equal(await generationRow(m), undefined);
  assert.deepEqual(
    await db.withWorkspace(WS, (tx) => requestPitchDraft(tx, { touchId: m, hint: null, instructions: null, userId: null })),
    { ok: false, code: 'opted_out' },
  );
});

test('«Redactar con IA» desde el editor: el worker redacta con las instrucciones, lo juzga y el toque vuelve a la persona; «Más corto» ve la versión anterior', async () => {
  const seen: GenerationInput[] = [];
  const base = createFakeGenerator();
  const spy: MessageGenerator = { name: base.name, model: base.model, generate: (input) => (seen.push(input), base.generate(input)) };
  const writers: Writers = { mode: 'fake', generator: spy, judge: createFakeJudge() };

  const nuevo = await db.withWorkspace(WS, (tx) =>
    savePitch(tx, { ...pitchBase, companyId: OLLA_FACIL, contactId: CAROLINA_OLLA, touchId: null, subject: null, body: '', intent: 'draft', now: new Date() }),
  );
  assert.ok(nuevo.ok);
  const t = nuevo.ok ? nuevo.touchId : '';
  assert.deepEqual(
    await db.withWorkspace(WS, (tx) => requestPitchDraft(tx, { touchId: t, hint: null, instructions: 'Habla de cocinar en una sola olla.', userId: null })),
    { ok: true },
  );
  const g = await runGenerate(motor, { writers, now: clock, workspaceId: WS });
  assert.ok(g.generated.includes(t), JSON.stringify(g));
  const pedido = seen.find((i) => i.company.name === 'Olla Fácil')!;
  assert.deepEqual([pedido.instructions, pedido.hint, pedido.stepType], ['Habla de cocinar en una sola olla.', null, 'email']);

  const r = await runReview(motor, { writers, now: clock, workspaceId: WS });
  assert.ok(r.returned.includes(t), JSON.stringify(r));
  const primero = await touch(t);
  assert.equal(primero.status, 'draft', 'vuelve a quien lo pidió: no se programa solo');
  assert.ok(primero.body.length > 0 && !primero.body.includes('[claim:'));
  assert.equal((await generationRow(t))?.stage, 'reviewed');
  const c = await db.withWorkspace(WS, (tx) => loadPitchComposer(tx, OLLA_FACIL, LOCALE));
  assert.equal(c.draft?.touchId, t);
  assert.equal(c.draft?.pending, null);
  assert.ok(c.draft?.review?.note, 'la nota del juez se ve en el editor');

  // «Más corto»: el generador recibe la pista y la versión anterior.
  seen.length = 0;
  await db.withWorkspace(WS, (tx) => requestPitchDraft(tx, { touchId: t, hint: 'shorter', instructions: null, userId: null }));
  assert.ok((await runGenerate(motor, { writers, now: clock, workspaceId: WS })).generated.includes(t));
  const corto = seen.find((i) => i.company.name === 'Olla Fácil')!;
  assert.equal(corto.hint, 'shorter');
  assert.ok(corto.previousDraft && corto.previousDraft.includes(primero.body.split('\n')[0]!), corto.previousDraft ?? '');
  await runReview(motor, { writers, now: clock, workspaceId: WS });
});

test('el motor rellena las doce variables de la lista canónica con la misma lectura que el pitch', async () => {
  const seq = await db.asWorker(async (tx) => {
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO outbound_sequence (workspace_id, name, channel, status, automation_mode)
       VALUES ($1, 'VEN-12 · plantilla con las doce variables', 'email', 'active', 'review') RETURNING id`,
      [WS],
    )).rows[0]!.id;
    await tx.query(
      `INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                                  subject_template, body_template, generate_with_ai)
       VALUES ($1, $2, 0, 0, 'email', 'email', '09:30', 'Una idea para {{company}}', $3, false)`,
      [WS, id, TEMPLATE_VARIABLES.map((v) => `${v}: {{${v}}}`).join('\n')],
    );
    return id;
  });
  const r = await motor.transaction((tx) =>
    enrollContacts(tx, { sequenceId: seq, contactIds: [VALENTINA_CAFE_ALMA], dealId: DEAL_CAFE_ALMA, now: clock(), appUrl: 'https://on-cue.test' }),
  );
  assert.equal(r.enrolled.length, 1, JSON.stringify(r.skipped));
  const row = await db.asWorker(async (tx) =>
    (await tx.query<TouchRow>('SELECT status, held_reason, subject, body, claims FROM outbound_touch WHERE enrollment_id = $1', [r.enrolled[0]!.enrollmentId])).rows[0]!,
  );
  assert.ok(!row.body.includes('{{'), row.body);
  assert.notEqual(row.held_reason?.split(':')[0], 'placeholders');
  const lines = Object.fromEntries(row.body.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  assert.equal(lines.first_name, 'Valentina');
  assert.equal(lines.role_title, 'Fundadora');
  assert.deepEqual([lines.company, lines.company_industry, lines.company_city], ['Café Alma', 'alimentos', 'Bogotá']);
  assert.ok(lines.signal_headline && lines.signal_headline.length > 0);
  assert.deepEqual([lines.sender_name, lines.creator_handle, lines.creator_niche], ['Laura Méndez', '@laura.cocinafacil', 'cocina']);
  assert.match(lines.media_kit_url ?? '', /^https:\/\/on-cue\.test\/kit\/[a-z0-9]+$/);
  assert.match(lines.quote_url ?? '', /^https:\/\/on-cue\.test\/cotizacion\/\S+$/);
});
