/**
 * VEN-13 · el recomendador contra la base: Postgres embebido con las
 * migraciones y el seed de la demo, con la RLS del espacio como la web.
 *
 * El «terminado cuando», en la capa de datos:
 *   · desde la señal de «campaña activa» del seed (Fresko Market, seis
 *     anuncios en Meta) sale una secuencia de seis pasos con guía, y se
 *     activa (el segundo clic);
 *   · la propuesta cambia si la persona no tiene LinkedIn;
 *   · la línea de tiempo se edita, se reordena y se bloquea al enrolar;
 *   · nada de esto cruza de un espacio a otro.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSequenceAgainstPolicy, recommendSequence, type RecommendInput } from '@mc/core';
import {
  addStep, CadenciaError, contactNames, createSequenceFromProposal, createSequenceFromTemplate, defaultContact, deleteStep,
  enrollableContactsOfDeal, liveEnrollmentElsewhere,
  duplicateSequence, getRecommendationContext, getSequenceDetail, listEnrollableDeals, listProposableSignals,
  listSequences, listSequenceTemplates, recordRecommendLlmCall, renameSequence, reorderSteps, replaceStepsFromProposal,
  setSequenceStatus, updateStep, type RecommendationContext,
} from '../src/queries/cadencias.ts';
import { enrollContacts } from '../src/queries/outreach/enroll.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** La señal de «campaña activa» del seed 0002 y su negocio abierto. */
const SIGNAL_FRESKO = '00000002-0000-4000-8000-00000005e001';
const DEAL_FRESKO = '00000002-0000-4000-8000-0000000dea07';
const COMPANY_FRESKO = '00000002-0000-4000-8000-0000000000e2';
const CAMILA = '00000002-0000-4000-8000-0000000c0001';
/** Una persona de Fresko con correo y sin LinkedIn, solo para esta prueba. */
const LUCIA = '00000013-0000-4000-8000-00000000c001';
const WS_OTRO = '00000013-0000-4000-8000-000000000001';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, role_title, email, source)
    VALUES ('${LUCIA}', '${COMPANY_FRESKO}', '${WORKSPACE_LAURA}', 'Lucía Parra', 'Trade marketing', 'lucia.parra@fresko.test', 'user_provided');
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_OTRO}', 'cadencias-otro', 'Otro espacio', 'America/Bogota');
  `);
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

const enLaura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);

function entrada(ctx: RecommendationContext, contactId: string | null): RecommendInput {
  const c = contactId ? ctx.contacts.find((x) => x.id === contactId)! : null;
  return {
    signalKind: ctx.signal.kind,
    nicheSlugs: ctx.nicheSlugs,
    channels: ctx.channels,
    allowedChannels: ctx.allowedChannels,
    contact: c ? { hasEmail: c.hasEmail, hasLinkedin: c.hasLinkedin, hasInstagram: c.hasInstagram } : null,
    requiresDisclosure: ctx.brief?.requiresDisclosure ?? false,
    templates: ctx.templates,
    policy: ctx.policy,
  };
}

const meta = (contactId: string | null) => ({
  signalId: SIGNAL_FRESKO, contactId, dealId: DEAL_FRESKO, guidance: 'rules' as const, guidanceWhyRules: 'no_key' as const,
  model: null,
});

test('las plantillas de 0037 y 0056: ocho activas, con una por cada tipo de señal', async () => {
  const tpls = await enLaura((tx) => listSequenceTemplates(tx));
  assert.equal(tpls.length, 8);
  for (const kind of ['active_campaign', 'launch', 'season', 'collab', 'manual']) {
    assert.ok(tpls.some((x) => x.signalKind === kind && x.nicheSlug === null), kind);
  }
});

test('la señal de campaña activa del seed está entre las que se proponen, con su negocio abierto', async () => {
  const lista = await enLaura((tx) => listProposableSignals(tx, 20));
  const fresko = lista.find((s) => s.signalId === SIGNAL_FRESKO);
  assert.ok(fresko);
  assert.equal(fresko.signalKind, 'active_campaign');
  assert.equal(fresko.dealId, DEAL_FRESKO);
});

test('el contexto: la persona por defecto llega por más canales y los canales salen de las cuentas', async () => {
  const ctx = await enLaura((tx) => getRecommendationContext(tx, SIGNAL_FRESKO));
  assert.equal(ctx.signal.kind, 'active_campaign');
  assert.equal(ctx.deal?.id, DEAL_FRESKO);
  assert.equal(defaultContact(ctx.contacts)?.id, CAMILA);
  assert.deepEqual(ctx.channels, { email: 'connected', linkedin: 'down', instagram_dm: 'missing' });
  assert.ok(ctx.nicheSlugs.includes('cocina'));
  assert.equal(ctx.brief?.requiresDisclosure, true);
  assert.equal(ctx.angles.presencia?.label, 'Presencia');
  assert.deepEqual(ctx.policy, { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3 });
});

test('terminado cuando: seis pasos con guía desde la campaña activa, y se activa', async () => {
  const id = await enLaura(async (tx) => {
    const ctx = await getRecommendationContext(tx, SIGNAL_FRESKO);
    const p = recommendSequence(entrada(ctx, CAMILA));
    return createSequenceFromProposal(tx, { proposal: p, name: 'Fresko · campaña activa', meta: meta(CAMILA) });
  });
  const d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  assert.equal(d.status, 'draft');
  assert.equal(d.steps.length, 6);
  assert.ok(d.steps.every((s) => (s.guidanceEs ?? '').length > 20), 'cada paso con su guía');
  assert.ok(d.steps.every((s) => s.angleKey !== null && s.angleLabel !== null), 'cada paso con su ángulo');
  assert.equal(d.signal?.id, SIGNAL_FRESKO);
  assert.equal(d.proposal?.contactId, CAMILA);
  assert.equal(d.proposal?.templateSlug, 'cocina-campana-activa');
  assert.ok(d.proposal?.notes.some((n) => n.code === 'channel_down'));
  // La propuesta nace dentro de la política del seed (4 mensajes, 3 días): ni un paso cortado ni corrido,
  // y el cierre con el media kit sigue ahí.
  assert.deepEqual([d.policy.overCap, d.policy.closerThanGap], [[], []]);
  assert.deepEqual(checkSequenceAgainstPolicy(d.steps, { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3 }), { overCap: [], closerThanGap: [] });
  assert.equal(d.steps.at(-1)!.angleKey, 'sintesis');
  assert.ok(d.steps.at(-1)!.requiresAsset !== null);
  assert.ok(d.proposal?.notes.some((n) => n.code === 'fitted_to_policy'));

  await enLaura((tx) => setSequenceStatus(tx, id, 'active'));
  assert.equal((await enLaura((tx) => getSequenceDetail(tx, id)))!.status, 'active');

  // La copia conserva la propuesta (sus notas) pero no la persona ni el negocio: activarla no le escribe a Camila otra vez.
  const copia = await enLaura((tx) => duplicateSequence(tx, id, (n) => `${n} (copia)`));
  const dc = (await enLaura((tx) => getSequenceDetail(tx, copia)))!;
  assert.equal(dc.proposal?.templateSlug, 'cocina-campana-activa');
  assert.deepEqual([dc.proposal?.contactId, dc.proposal?.dealId, dc.proposalContact], [null, null, null]);
  await enLaura((tx) => setSequenceStatus(tx, copia, 'archived'));
});

test('proponer dos veces desde la misma señal deja un solo borrador, con los pasos de la última propuesta', async () => {
  const [a, b] = await enLaura(async (tx) => {
    const ctx = await getRecommendationContext(tx, SIGNAL_FRESKO);
    const primera = await createSequenceFromProposal(tx, { proposal: recommendSequence(entrada(ctx, CAMILA)), name: 'Fresko · campaña activa', meta: meta(CAMILA) });
    const segunda = await createSequenceFromProposal(tx, { proposal: recommendSequence(entrada(ctx, LUCIA)), name: 'Fresko · campaña activa', meta: meta(LUCIA) });
    return [primera, segunda];
  });
  assert.equal(a, b);
  const borradores = (await enLaura((tx) => listSequences(tx))).filter((s) => s.status === 'draft' && s.name === 'Fresko · campaña activa');
  assert.equal(borradores.length, 1);
  const d = (await enLaura((tx) => getSequenceDetail(tx, a)))!;
  assert.equal(d.proposal?.contactId, LUCIA);
  assert.ok(!d.steps.some((s) => s.stepType === 'linkedin_message'), 'los pasos son los de Lucía, sin LinkedIn');
  await enLaura((tx) => setSequenceStatus(tx, a, 'archived'));
});

test('enrolar desde un negocio solo acepta personas de la marca del negocio, con el negocio abierto', async () => {
  const otra = await enLaura(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `SELECT c.id FROM contact c WHERE c.company_id <> $1::uuid AND contact_visible_to(c.id, $2::uuid) ORDER BY c.id LIMIT 1`,
      [COMPANY_FRESKO, tx.workspaceId],
    );
    return r.rows[0]!.id;
  });
  const ok = await enLaura((tx) => enrollableContactsOfDeal(tx, DEAL_FRESKO, [CAMILA, LUCIA, otra]));
  assert.deepEqual(new Set(ok), new Set([CAMILA, LUCIA]));
  await assert.rejects(enLaura((tx) => enrollableContactsOfDeal(tx, DEAL_FRESKO, ['no'])), (e) => e instanceof CadenciaError && e.code === 'invalid');
  const nombres = await enLaura((tx) => contactNames(tx, [CAMILA, 'no']));
  assert.deepEqual([...nombres], [[CAMILA, 'Camila Rojas']]);
});

test('WhatsApp (fase 2) no se pone a mano: ni al añadir ni al editar', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'senal-manual'));
  const [p1] = (await enLaura((tx) => getSequenceDetail(tx, id)))!.steps;
  await assert.rejects(enLaura((tx) => addStep(tx, id, { stepType: 'whatsapp_message' })), (e) => e instanceof CadenciaError && e.code === 'invalid');
  await assert.rejects(enLaura((tx) => updateStep(tx, p1!.id, { stepType: 'whatsapp_message' })), (e) => e instanceof CadenciaError && e.code === 'invalid');
  // Una tarea a mano sí elige su red.
  await enLaura((tx) => updateStep(tx, p1!.id, { stepType: 'manual_task', channel: 'linkedin' }));
  const d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  assert.deepEqual([d.steps[0]!.stepType, d.steps[0]!.channel], ['manual_task', 'linkedin']);
  // El que era el segundo correo pasa a abrir el hilo.
  assert.equal(d.steps.find((s) => s.channel === 'email')!.stepType, 'email');
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
});

test('la propuesta cambia si la persona no tiene LinkedIn', async () => {
  const [camila, lucia] = await enLaura(async (tx) => {
    const ctx = await getRecommendationContext(tx, SIGNAL_FRESKO);
    return [recommendSequence(entrada(ctx, CAMILA)), recommendSequence(entrada(ctx, LUCIA))];
  });
  assert.equal(lucia.steps.length, 6);
  assert.notDeepEqual(lucia.steps.map((s) => s.stepType), camila.steps.map((s) => s.stepType));
  assert.ok(camila.steps.some((s) => s.stepType === 'linkedin_message'));
  assert.ok(!lucia.steps.some((s) => s.stepType === 'linkedin_message'));
});

test('la línea de tiempo: editar, reordenar, añadir y quitar; con alguien dentro, la forma no cambia', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  const antes = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  const [p1, p2, p3] = antes.steps;

  await enLaura((tx) => updateStep(tx, p2!.id, { guidanceEs: 'Abre con su cliente de 25 a 34. No menciones precio.', scheduledTime: '11:15' }));
  // Mover el correo del día 1 al primer puesto: toma el día 0; el comentario pasa al día 1.
  await enLaura((tx) => reorderSteps(tx, id, [p2!.id, p1!.id, ...antes.steps.slice(2).map((s) => s.id)]));
  let d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  assert.deepEqual(d.steps.slice(0, 2).map((s) => [s.id, s.dayOffset]), [[p2!.id, 0], [p1!.id, 1]]);
  assert.equal(d.steps[0]!.scheduledTime, '11:15');
  assert.match(d.steps[0]!.guidanceEs!, /25 a 34/);

  const nuevo = await enLaura((tx) => addStep(tx, id, { stepType: 'email_reply', angleKey: 'prueba_social' }));
  d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  assert.equal(d.steps.at(-1)!.id, nuevo);
  assert.equal(d.steps.at(-1)!.dayOffset, 12, 'tras el último, con la separación de la política (3 días)');
  await enLaura((tx) => deleteStep(tx, nuevo));
  await enLaura((tx) => renameSequence(tx, id, '  Fresko   · plantilla '));

  await enLaura((tx) => setSequenceStatus(tx, id, 'active'));
  const r = await enLaura((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [CAMILA], dealId: DEAL_FRESKO }));
  assert.equal(r.enrolled.length, 1);
  await assert.rejects(enLaura((tx) => updateStep(tx, p3!.id, { dayOffset: 4 })), (e) => e instanceof CadenciaError && e.code === 'has_enrollments');
  await assert.rejects(enLaura((tx) => reorderSteps(tx, id, d.steps.map((s) => s.id).reverse())), (e) => e instanceof CadenciaError && e.code === 'has_enrollments');
  // El texto sí: vale para quien se enrole después.
  await enLaura((tx) => updateStep(tx, p3!.id, { guidanceEs: 'Un video de desayunos con sus views.' }));
  await assert.rejects(
    enLaura(async (tx) => {
      const ctx = await getRecommendationContext(tx, SIGNAL_FRESKO);
      await replaceStepsFromProposal(tx, id, { proposal: recommendSequence(entrada(ctx, CAMILA)), meta: meta(CAMILA) });
    }),
    (e) => e instanceof CadenciaError && e.code === 'has_enrollments',
  );

  const lista = await enLaura((tx) => listSequences(tx));
  const fila = lista.find((x) => x.id === id)!;
  assert.equal(fila.name, 'Fresko · plantilla');
  assert.deepEqual([fila.steps, fila.enrolledLive, fila.status], [6, 1, 'active']);

  const copia = await enLaura((tx) => duplicateSequence(tx, id, (n) => `${n} (copia)`));
  const dc = (await enLaura((tx) => getSequenceDetail(tx, copia)))!;
  assert.deepEqual([dc.status, dc.steps.length, dc.locked], ['draft', 6, false]);
  // Quien ya está en la original está «vivo» ahí: la copia no puede volver a escribirle en paralelo.
  assert.deepEqual(await enLaura((tx) => liveEnrollmentElsewhere(tx, CAMILA, copia)), { sequenceId: id, name: 'Fresko · plantilla' });
  assert.equal(await enLaura((tx) => liveEnrollmentElsewhere(tx, CAMILA, id)), null);
  const deals = await enLaura((tx) => listEnrollableDeals(tx, id));
  assert.equal(deals.find((x) => x.id === DEAL_FRESKO)!.contacts.find((c) => c.id === CAMILA)!.enrolled, true);
  assert.equal(deals.find((x) => x.id === DEAL_FRESKO)!.contacts.find((c) => c.id === LUCIA)!.enrolled, false);

  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
  await assert.rejects(enLaura((tx) => setSequenceStatus(tx, id, 'active')), (e) => e instanceof CadenciaError && e.code === 'archived');
  assert.ok(!(await enLaura((tx) => listSequences(tx))).some((x) => x.id === id));
});

test('reordenar pone al primer correo como correo nuevo, no como respuesta sin hilo', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  const d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  // Orden nuevo: la respuesta del día 5 (paso 4) delante del primer correo.
  const ids = d.steps.map((s) => s.id);
  await enLaura((tx) => reorderSteps(tx, id, [ids[0]!, ids[3]!, ids[1]!, ids[2]!, ids[4]!, ids[5]!]));
  const e = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  assert.equal(e.steps[1]!.id, ids[3]);
  assert.equal(e.steps[1]!.stepType, 'email');
});

test('quitar, añadir o editar tampoco deja una respuesta sin hilo como primer correo', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  const pasos = async () => (await enLaura((tx) => getSequenceDetail(tx, id)))!.steps;
  const primerCorreo = async () => (await pasos()).find((s) => s.channel === 'email' && s.stepType !== 'manual_task')!;
  const ids = (await pasos()).map((s) => s.id);

  // Quitar el correo que abre el hilo: la respuesta del día 5 pasa a abrirlo.
  await enLaura((tx) => deleteStep(tx, ids[1]!));
  assert.deepEqual([(await primerCorreo()).id, (await primerCorreo()).stepType], [ids[3], 'email']);

  // Cambiar el primer correo a «Respuesta en el hilo» no se queda así.
  await enLaura((tx) => updateStep(tx, ids[3]!, { stepType: 'email_reply' }));
  assert.equal((await primerCorreo()).stepType, 'email');

  // Sin ningún correo, «Añadir paso» (una respuesta) abre el hilo, con un ángulo que la secuencia no usa y su guía.
  for (const s of await pasos()) if (s.channel === 'email') await enLaura((tx) => deleteStep(tx, s.id));
  const nuevo = await enLaura((tx) => addStep(tx, id, { stepType: 'email_reply' }));
  const n = (await pasos()).find((s) => s.id === nuevo)!;
  assert.equal(n.stepType, 'email');
  const usados = (await pasos()).filter((s) => s.id !== nuevo).map((s) => s.angleKey);
  assert.ok(n.angleKey && !usados.includes(n.angleKey), `ángulo nuevo: ${n.angleKey}`);
  assert.match(n.guidanceEs ?? '', /^Abre con/);
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
});

test('los negocios abiertos para enrolar traen a sus personas; la baja se marca', async () => {
  const deals = await enLaura((tx) => listEnrollableDeals(tx));
  const fresko = deals.find((d) => d.id === DEAL_FRESKO)!;
  assert.ok(fresko.contacts.some((c) => c.id === CAMILA && c.hasEmail && c.hasLinkedin && !c.optedOut));
  const granos = deals.find((d) => d.companyName.startsWith('Granos'));
  assert.ok(granos?.contacts.some((c) => c.optedOut), 'Mateo Giraldo pidió la baja en el seed');
});

test('otro espacio no ve las cadencias de Laura ni puede nombrar su señal', async () => {
  const [mia] = await enLaura((tx) => listSequences(tx));
  assert.ok(mia);
  assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => getSequenceDetail(tx, mia.id)), null);
  assert.deepEqual(await t.db.withWorkspace(WS_OTRO, (tx) => listSequences(tx)), []);
  await assert.rejects(
    t.db.withWorkspace(WS_OTRO, (tx) => getRecommendationContext(tx, SIGNAL_FRESKO)),
    (e) => e instanceof CadenciaError && e.code === 'no_signal',
  );
  const ctx = await enLaura((tx) => getRecommendationContext(tx, SIGNAL_FRESKO));
  await assert.rejects(
    t.db.withWorkspace(WS_OTRO, (tx) =>
      createSequenceFromProposal(tx, { proposal: recommendSequence(entrada(ctx, null)), name: 'Ajena', meta: meta(null) })),
    /no existe o que esta transacción no puede ver/,
  );
  await assert.rejects(t.db.withWorkspace(WS_OTRO, (tx) => setSequenceStatus(tx, mia.id, 'paused')), (e) => e instanceof CadenciaError && e.code === 'not_found');
});

test('cada llamada del recomendador al modelo queda con sus tokens y su costo', async () => {
  await enLaura((tx) => recordRecommendLlmCall(tx, { model: 'claude-sonnet-5', inputTokens: 1200, outputTokens: 400 }));
  const rows = await enLaura((tx) =>
    tx.query<{ cost: string; purpose: string }>(`SELECT cost::text, purpose FROM outbound_llm_call WHERE purpose = 'recommend'`));
  assert.deepEqual(rows.rows, [{ cost: '0.006400', purpose: 'recommend' }]);
});
