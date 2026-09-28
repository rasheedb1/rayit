/**
 * VEN-12 ronda 3 · lo que la ronda 2 dejaba abierto en el worker, sobre el
 * seed del repositorio en Postgres embebido. Sin red ni llave.
 *
 *   · la aprobación de un mensaje retenido exige origen a cada cifra
 *     (releaseHeldTouch), también si la persona edita el texto;
 *   · outbound_review no pierde intentos: cada corrida numera los suyos
 *     (run), y la nota que ve el editor es la del intento ELEGIDO;
 *   · un toque cuyo modelo devuelve siempre algo ilegible no se paga cada
 *     dos minutos: espera creciente y, a los tres, lo escribe una persona;
 *   · si el job se corta a mitad, lo ya hecho queda en outbound_review;
 *   · la compuerta B compara también con lo redactado en el mismo lote.
 *
 * Base propia: la cola de este archivo no se cruza con la de
 * outreach-generacion.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddedDb } from '@mc/db/embedded';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { LlmMessageGenerator, type MessageGenerator } from '@mc/core/outreach/generate';
import type { MessageJudge } from '@mc/core/outreach/judge';
import type { LlmClient } from '@mc/core/outreach/llm';
import {
  enrollContacts, listSalesClaims, loadPitchComposer, releaseHeldTouch, requestPitchDraft, savePitch,
} from '@mc/db/queries/outreach';
import { motorDbFromClient, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import { runGenerate } from '../src/jobs/ventas/outbound.generate.ts';
import { runReview } from '../src/jobs/ventas/outbound.review.ts';
import type { Writers } from '../src/jobs/ventas/redaccion.ts';
import { SETUP_TIMEOUT } from './helpers/harness.ts';

const WS = '00000002-0000-4000-8000-000000000001';
const VITALE = '00000002-0000-4000-8000-0000000000e7';
const OLLA_FACIL = '00000002-0000-4000-8000-0000000000e8';
const LOCALE = 'es-CO';

let db: EmbeddedDb;
let motor: MotorDb;
let sequenceId: string;
const fake: Writers = { mode: 'fake', generator: createFakeGenerator(), judge: createFakeJudge() };
/** El generador redacta un toque el día antes de su hora: los jobs corren con el reloj una semana adelante. */
const T0 = Date.now() + 7 * 24 * 3600_000;
const at = (minutes: number) => () => new Date(T0 + minutes * 60_000);

before(async () => {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  db = await createEmbeddedDb({ seeds: true, snapshot: true });
  motor = motorDbFromClient(db);
  sequenceId = await db.asWorker(async (tx) => {
    const seq = (await tx.query<{ id: string }>(
      `INSERT INTO outbound_sequence (workspace_id, name, channel, status, automation_mode)
       VALUES ($1, 'VEN-12 r3 · encaje de audiencia', 'email', 'active', 'review') RETURNING id`,
      [WS],
    )).rows[0]!.id;
    await tx.query(
      `INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id,
                                  guidance_es, generate_with_ai)
       SELECT $1, $2, 0, 0, 'email', 'email', '09:30', a.id, 'Abre con la coincidencia entre tu audiencia y su cliente.', true
         FROM outbound_angle a WHERE a.workspace_id IS NULL AND a.key = 'encaje_audiencia'`,
      [WS, seq],
    );
    await tx.query(`UPDATE outbound_policy SET postal_address = 'Calle 93 # 11-26, Bogotá', llm_daily_cap_usd = 50 WHERE workspace_id = $1`, [WS]);
    return seq;
  });
}, SETUP_TIMEOUT);

after(async () => {
  await db?.close();
});

let contactSeq = 0;
/** Una persona nueva en una empresa del seed, enrolada hoy; devuelve su toque en borrador. */
async function enrollNew(companyId: string, fullName: string): Promise<string> {
  contactSeq += 1;
  const id = `00000613-0000-4000-8000-${String(contactSeq).padStart(12, '0')}`;
  const email = `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}.${contactSeq}@marca.co`;
  await db.execAsSuperuser(
    `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, role_title, email, source)
     VALUES ('${id}', '${companyId}', '${WS}', '${fullName}', 'Mercadeo', '${email}', 'user_provided')`,
  );
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId, contactIds: [id], now: new Date() }));
  assert.equal(r.enrolled.length, 1, JSON.stringify(r.skipped));
  return db.asWorker(async (tx) =>
    (await tx.query<{ id: string }>('SELECT id FROM outbound_touch WHERE enrollment_id = $1', [r.enrolled[0]!.enrollmentId])).rows[0]!.id,
  );
}

const touch = (id: string) =>
  db.asWorker(async (tx) =>
    (await tx.query<{ status: string; held_reason: string | null; subject: string | null; body: string; claims: Array<{ id: string }> }>(
      'SELECT status, held_reason, subject, body, claims FROM outbound_touch WHERE id = $1', [id],
    )).rows[0]!,
  );
const generation = (id: string) =>
  db.asWorker(async (tx) =>
    (await tx.query<{ stage: string; failures: number; next_attempt_at: Date | null; last_error: string | null; judge_note: string | null; chosen_attempt: number | null; review_run: number | null; total_score: string | null }>(
      'SELECT stage, failures, next_attempt_at, last_error, judge_note, chosen_attempt, review_run, total_score FROM outbound_generation WHERE touch_id = $1', [id],
    )).rows[0],
  );
const reviews = (id: string) =>
  db.asWorker(async (tx) =>
    (await tx.query<{ run: number; attempt: number; decision: string; regenerate_hint: string | null; gates: Record<string, unknown>; cost: string; input_tokens: number }>(
      'SELECT run, attempt, decision, regenerate_hint, gates, cost, input_tokens FROM outbound_review WHERE touch_id = $1 ORDER BY run, attempt', [id],
    )).rows,
  );

/** Un generador que siempre mete una cifra inventada (sin origen) antes de la pregunta. */
function liar(): MessageGenerator {
  const base = createFakeGenerator();
  return {
    name: 'mentiroso', model: base.model,
    async generate(input, opts) {
      const out = await base.generate(input, opts);
      return { ...out, body: out.body.replace('\n\n¿', ' Tengo 987.654 seguidores fieles.\n\n¿') };
    },
  };
}

// ---------------------------------------------------------------------
// La aprobación de lo retenido
// ---------------------------------------------------------------------

test('un retenido por una cifra sin origen no se aprueba tal cual ni editado con otra inventada; con una cifra del perfil sí, y los claims se recalculan', async () => {
  const t = await enrollNew(VITALE, 'Ramiro Díaz');
  const w: Writers = { mode: 'fake', generator: liar(), judge: createFakeJudge() };
  assert.ok((await runGenerate(motor, { writers: w, now: at(0), workspaceId: WS })).generated.includes(t));
  const r = await runReview(motor, { writers: w, now: at(0), workspaceId: WS });
  assert.equal(r.held.find((h) => h.touchId === t)?.reason, 'quality_risk');
  const held = await touch(t);
  assert.match(held.held_reason ?? '', /^quality_risk:.*unsourced_figure/);
  assert.ok(held.body.includes('987.654 seguidores'), held.body);

  const aprobar = (body: string) => db.withWorkspace(WS, (tx) => releaseHeldTouch(tx, t, { subject: held.subject, body }));
  // Tal cual: la cifra inventada no sale.
  assert.deepEqual(await aprobar(held.body), { ok: false, code: 'unsourced_figure', detail: '987.654' });
  // Editada con otra cifra inventada, tampoco.
  assert.deepEqual(
    await aprobar(held.body.replace('Tengo 987.654 seguidores fieles.', 'Mis clientes vendieron x3.')),
    { ok: false, code: 'unsourced_figure', detail: 'x3' },
  );
  // Con una cifra del perfil (escrita a mano, sin fichas): sale, y outbound_touch.claims dice de dónde.
  const claims = await db.withWorkspace(WS, (tx) => listSalesClaims(tx, { locale: LOCALE }));
  const mediana = claims.find((c) => c.id === 'baseline:tiktok:median_views');
  assert.ok(mediana, JSON.stringify(claims.map((c) => c.id)));
  const bien = held.body.replace('Tengo 987.654 seguidores fieles.', `Mi mediana en TikTok es de ${mediana.display} views.`);
  assert.deepEqual(await aprobar(bien), { ok: true });
  const after = await touch(t);
  assert.equal(after.status, 'scheduled');
  assert.ok(after.claims.some((c) => c.id === mediana.id), JSON.stringify(after.claims));
});

// ---------------------------------------------------------------------
// outbound_review no pierde intentos, y la nota es la del elegido
// ---------------------------------------------------------------------

/** Un juez que califica, en cada corrida, 7 · 7,5 · 6 · 6,5 · 5: el mejor es siempre el intento 2, y ninguno pasa. */
function juezEnSerie(): MessageJudge & { calls: number } {
  const serie = [7, 7.5, 6, 6.5, 5];
  const j = {
    name: 'serie', model: 'claude-sonnet-5', calls: 0,
    async judge() {
      const i = j.calls % serie.length;
      j.calls += 1;
      const s = serie[i]!;
      return {
        scores: { relevance: s, quality: s, structure: s, voice: s }, riskTriggers: [], hint: null, note: `Nota del intento ${i + 1}.`,
        model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 80, costUsd: 0.0028,
      };
    },
  };
  return j;
}

test('tres «Otra versión» seguidas: quince intentos en tres corridas, ninguno descartado; el editor enseña la nota del intento elegido', async () => {
  contactSeq += 1;
  const contactId = `00000613-0000-4000-8000-${String(contactSeq).padStart(12, '0')}`;
  await db.execAsSuperuser(
    `INSERT INTO contact (id, company_id, owner_workspace_id, full_name, role_title, email, source)
     VALUES ('${contactId}', '${OLLA_FACIL}', '${WS}', 'Lucía Prieto', 'Mercadeo', 'lucia.prieto@ollafacil.co', 'user_provided')`,
  );
  const nuevo = await db.withWorkspace(WS, (tx) =>
    savePitch(tx, { companyId: OLLA_FACIL, contactId, dealId: null, touchId: null, subject: null, body: '', intent: 'draft', userId: null, locale: LOCALE, now: new Date() }),
  );
  assert.ok(nuevo.ok);
  const t = nuevo.ok ? nuevo.touchId : '';
  const juez = juezEnSerie();
  const w: Writers = { mode: 'fake', generator: createFakeGenerator(), judge: juez };
  for (let vez = 0; vez < 3; vez++) {
    assert.deepEqual(await db.withWorkspace(WS, (tx) => requestPitchDraft(tx, { touchId: t, hint: null, instructions: null, userId: null })), { ok: true });
    assert.ok((await runGenerate(motor, { writers: w, now: at(0), workspaceId: WS })).generated.includes(t));
    assert.ok((await runReview(motor, { writers: w, now: at(0), workspaceId: WS })).returned.includes(t));
  }
  const rows = await reviews(t);
  assert.equal(rows.length, 15, JSON.stringify(rows.map((x) => [x.run, x.attempt, x.decision])));
  assert.deepEqual(rows.map((x) => [x.run, x.attempt]), [1, 2, 3].flatMap((run) => [1, 2, 3, 4, 5].map((a) => [run, a])));
  // Cada intento dice lo que costó juzgarlo: el 11.º y los siguientes también.
  assert.ok(rows.every((x) => x.input_tokens >= 1000 && Number(x.cost) >= 0.0028), JSON.stringify(rows.map((x) => x.cost)));
  const cierre = rows.filter((x) => x.attempt === 5);
  assert.deepEqual(cierre.map((x) => [x.decision, x.gates.chosen_attempt]), [['send_best', 2], ['send_best', 2], ['send_best', 2]]);

  const g = await generation(t);
  assert.deepEqual([g?.review_run, g?.chosen_attempt, g?.judge_note, Number(g?.total_score)], [3, 2, 'Nota del intento 2.', 7.5]);
  const c = await db.withWorkspace(WS, (tx) => loadPitchComposer(tx, OLLA_FACIL, LOCALE));
  assert.equal(c.draft?.touchId, t);
  assert.deepEqual(c.draft?.review, { total: 7.5, note: 'Nota del intento 2.', attempt: 2 });
  assert.ok(c.draft?.generationStamp, 'el borrador de la IA trae su sello');
});

// ---------------------------------------------------------------------
// Fallos: espera creciente y, a los tres del modelo, una persona
// ---------------------------------------------------------------------

test('un modelo que siempre se corta en el tope no se paga cada dos minutos: espera 2 y 8 minutos, y al tercer fallo lo escribe una persona', async () => {
  let llamadas = 0;
  const cortado: LlmClient = {
    name: 'cortado',
    async complete(req) {
      llamadas += 1;
      return { text: '{"subject":"Una idea para', model: req.model, inputTokens: 1500, outputTokens: 900, costUsd: 0.0105, stopReason: 'max_tokens' };
    },
  };
  const w: Writers = { mode: 'anthropic', generator: new LlmMessageGenerator(cortado), judge: createFakeJudge() };
  const t = await enrollNew(VITALE, 'Elena Ruiz');

  const primero = await runGenerate(motor, { writers: w, now: at(0), workspaceId: WS });
  assert.ok(primero.errors.some((e) => e.touchId === t));
  let g = await generation(t);
  assert.deepEqual([g?.stage, g?.failures, g?.last_error], ['generating', 1, 'llm_output']);
  assert.equal(g?.next_attempt_at?.getTime(), at(2)().getTime());
  // Antes de su hora no se toma: no se vuelve a pagar.
  await runGenerate(motor, { writers: w, now: at(1), workspaceId: WS });
  assert.equal(llamadas, 1);
  await runGenerate(motor, { writers: w, now: at(3), workspaceId: WS });
  g = await generation(t);
  assert.deepEqual([llamadas, g?.failures, g?.next_attempt_at?.getTime()], [2, 2, at(3 + 8)().getTime()]);
  const tercero = await runGenerate(motor, { writers: w, now: at(12), workspaceId: WS });
  assert.deepEqual(tercero.gaveUp, [t]);
  g = await generation(t);
  assert.deepEqual([g?.stage, g?.failures, g?.last_error, g?.next_attempt_at], ['failed', 3, 'llm_error', null]);
  const retenido = await touch(t);
  assert.deepEqual([retenido.status, retenido.held_reason?.split(':')[0]], ['held', 'llm_error']);
  // Las tres llamadas se pagaron y quedan en outbound_llm_call; después, ni una más.
  await runGenerate(motor, { writers: w, now: at(24 * 60), workspaceId: WS });
  assert.equal(llamadas, 3);
  const pagadas = await db.asWorker(async (tx) =>
    (await tx.query<{ n: number; cost: string }>(`SELECT count(*)::int AS n, sum(cost) AS cost FROM outbound_llm_call WHERE touch_id = $1`, [t])).rows[0]!,
  );
  assert.deepEqual([pagadas.n, Number(pagadas.cost)], [3, 0.0315]);
});

// ---------------------------------------------------------------------
// El plazo del job
// ---------------------------------------------------------------------

test('si el job se corta mientras el juez piensa, el intento ya pagado queda en outbound_review y la siguiente corrida lo retoma con su propia corrida', async () => {
  const t = await enrollNew(OLLA_FACIL, 'Iván Mora');
  assert.ok((await runGenerate(motor, { writers: fake, now: at(0), workspaceId: WS })).generated.includes(t));
  const abort = new AbortController();
  let senal: AbortSignal | undefined;
  const cortaJuez: MessageJudge = {
    name: 'corta', model: 'claude-sonnet-5',
    async judge(_input, opts) {
      senal = opts?.signal;
      abort.abort(new Error('timeout'));
      throw new Error('Request was aborted.');
    },
  };
  const r = await runReview(motor, {
    writers: { mode: 'fake', generator: createFakeGenerator(), judge: cortaJuez }, now: at(0), workspaceId: WS, signal: abort.signal,
  });
  assert.deepEqual(r.interrupted, [t]);
  assert.equal(senal, abort.signal, 'la señal del job llega a la llamada del juez');
  let rows = await reviews(t);
  assert.deepEqual(rows.map((x) => [x.run, x.attempt, x.gates.interrupted]), [[1, 1, true]]);
  assert.deepEqual([(await generation(t))?.stage, (await generation(t))?.failures], ['generated', 0]);

  // Con el plazo casi vencido no se empieza: se suelta sin llamar a nadie.
  const juez = createFakeJudge();
  let juicios = 0;
  const contado: Writers = { mode: 'fake', generator: createFakeGenerator(), judge: { ...juez, judge: (i, o) => ((juicios += 1), juez.judge(i, o)) } };
  const sinTiempo = await runReview(motor, { writers: contado, now: at(0), workspaceId: WS, deadline: Date.now() + 30_000 });
  assert.deepEqual([sinTiempo.interrupted, juicios], [[t], 0]);

  const r2 = await runReview(motor, { writers: contado, now: at(0), workspaceId: WS });
  assert.ok(r2.held.some((h) => h.touchId === t), JSON.stringify(r2));
  rows = await reviews(t);
  assert.deepEqual(rows.map((x) => [x.run, x.attempt, x.decision]), [[1, 1, 'reject'], [2, 1, 'pass']]);
});

// ---------------------------------------------------------------------
// Compuerta B dentro del mismo lote
// ---------------------------------------------------------------------

/** Un generador de plantilla: el mismo correo para todas, con la marca y la persona cambiadas. */
function plantilla(): MessageGenerator {
  return {
    name: 'plantilla', model: 'on-cue-fake-guion',
    async generate(input) {
      const quien = input.contact?.fullName?.split(' ')[0] ?? 'equipo';
      const body = [
        `Hola ${quien},`,
        '',
        `Vi lo último de ${input.company.name} y pensé en mi audiencia, que cocina en casa todas las semanas y busca ideas simples para el día a día.`,
        '',
        '¿Te interesa que te mande una idea de video?',
        '',
        input.creator.name,
      ].join('\n');
      return { subject: `Una idea para ${input.company.name}`, body, model: 'on-cue-fake-guion', inputTokens: 10, outputTokens: 10, costUsd: 0 };
    },
  };
}

test('compuerta B en el mismo lote: dos correos de plantilla redactados juntos se comparan entre sí, y el segundo se rehace con otro ángulo', async () => {
  const a = await enrollNew(VITALE, 'Tomás León');
  const b = await enrollNew(OLLA_FACIL, 'Sara Vélez');
  const g = await runGenerate(motor, { writers: { mode: 'fake', generator: plantilla(), judge: createFakeJudge() }, now: at(0), workspaceId: WS });
  assert.ok(g.generated.includes(a) && g.generated.includes(b), JSON.stringify(g));
  await runReview(motor, { writers: fake, now: at(0), workspaceId: WS });
  const primeros = [...(await reviews(a)), ...(await reviews(b))].filter((x) => x.attempt === 1);
  const parado = primeros.find((x) => (x.gates.similarity as { codes: string[] }).codes.includes('too_similar'));
  assert.ok(parado, JSON.stringify(primeros.map((x) => x.gates.similarity)));
  assert.deepEqual([parado.decision, parado.regenerate_hint], ['reject', 'other_angle']);
  const [ta, tb] = [await touch(a), await touch(b)];
  const { textSimilarity } = await import('@mc/core/outreach/gates');
  assert.ok(textSimilarity(ta.body, tb.body) < 0.65, `${ta.body}\n---\n${tb.body}`);
});
