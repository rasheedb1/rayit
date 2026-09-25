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
  enrollableContactsOfDeal, liveEnrollmentElsewhere, liveEnrollmentsElsewhere, optedOutAmong, parseSequenceProposal, signalContacts,
  duplicateSequence, getRecommendationContext, getSequenceDetail, listEnrollableDeals, listProposableSignals, reachForSequence,
  listSequences, listSequenceTemplates, recordRecommendLlmCall, renameSequence, reorderSteps, replaceStepsFromProposal,
  setSequenceStatus, updateStep, type RecommendationContext,
} from '../src/queries/cadencias/index.ts';
import { enrollContacts } from '../src/queries/outreach/enroll.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** La señal de «campaña activa» del seed 0002 y su negocio abierto. */
const SIGNAL_FRESKO = '00000002-0000-4000-8000-00000005e001';
const DEAL_FRESKO = '00000002-0000-4000-8000-0000000dea07';
const COMPANY_FRESKO = '00000002-0000-4000-8000-0000000000e2';
const CAMILA = '00000002-0000-4000-8000-0000000c0001';
/** Andrés Pardo, de Fresko: solo tiene Instagram. */
const ANDRES = '00000002-0000-4000-8000-0000000c0002';
/** Laura Méndez (cocina) y su brief activo, del seed 0002. */
const LAURA_CREADORA = '00000002-0000-4000-8000-000000000003';
const BRIEF_LAURA = '00000002-0000-4000-8000-0000000b0001';
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
  signalId: SIGNAL_FRESKO, contactId, dealId: DEAL_FRESKO, briefId: BRIEF_LAURA, guidance: 'rules' as const,
  guidanceWhyRules: 'no_key' as const, model: null,
});

test('las plantillas de 0037 y 0056: ocho activas, con una por cada tipo de señal', async () => {
  const tpls = await enLaura((tx) => listSequenceTemplates(tx));
  assert.equal(tpls.length, 8);
  for (const kind of ['active_campaign', 'launch', 'season', 'collab', 'manual']) {
    assert.ok(tpls.some((x) => x.signalKind === kind && x.nicheSlug === null), kind);
  }
});

test('la señal de campaña activa del seed está entre las que se proponen, con su negocio abierto', async () => {
  const { signals: lista, total } = await enLaura((tx) => listProposableSignals(tx, { limit: 20 }));
  const fresko = lista.find((s) => s.signalId === SIGNAL_FRESKO);
  assert.equal(total, lista.length);
  // Con un límite, el total sigue diciendo cuántas hay: la lista ofrece «Ver todas» y ninguna queda sin camino.
  const una = await enLaura((tx) => listProposableSignals(tx, { limit: 1 }));
  assert.deepEqual([una.signals.length, una.total], [1, total]);
  // Las de una empresa: lo que la ficha pone junto a cada negocio.
  const deFresko = await enLaura((tx) => listProposableSignals(tx, { companyId: COMPANY_FRESKO }));
  assert.deepEqual(deFresko.signals.map((s) => s.signalId), [SIGNAL_FRESKO]);
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
  assert.deepEqual(ctx.nicheSlugs, ['cocina']);
  assert.deepEqual(ctx.creator, { id: LAURA_CREADORA, name: 'Laura Méndez' });
  assert.equal(ctx.brief?.id, BRIEF_LAURA);
  assert.equal(ctx.brief?.requiresDisclosure, true);
  assert.deepEqual(ctx.notes, []);
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
  // La secuencia sabe de qué brief sale: el generador (VEN-12) lo lee de outbound_sequence.brief_id.
  const brief = await enLaura((tx) => tx.query<{ brief_id: string | null }>(`SELECT brief_id FROM outbound_sequence WHERE id = $1::uuid`, [id]));
  assert.equal(brief.rows[0]?.brief_id, BRIEF_LAURA);
  // Cada guía sabe quién la escribió y para qué tipo de paso: ninguna queda por revisar.
  assert.ok(d.steps.every((s) => s.guidanceSource === 'template' || s.guidanceSource === 'rules'));
  assert.ok(d.steps.every((s) => !s.guidanceStale && s.guidanceWrittenFor === s.stepType));
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

  const { id: nuevo } = await enLaura((tx) => addStep(tx, id, { stepType: 'email_reply', angleKey: 'prueba_social' }));
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
  // El lote entero en una sola consulta: solo sale quien está viva en otra.
  const vivas = await enLaura((tx) => liveEnrollmentsElsewhere(tx, [CAMILA, LUCIA], copia));
  assert.deepEqual([...vivas.entries()], [[CAMILA, { sequenceId: id, name: 'Fresko · plantilla' }]]);
  const deals = await enLaura((tx) => listEnrollableDeals(tx, id));
  assert.equal(deals.find((x) => x.id === DEAL_FRESKO)!.contacts.find((c) => c.id === CAMILA)!.enrolled, true);
  assert.equal(deals.find((x) => x.id === DEAL_FRESKO)!.contacts.find((c) => c.id === LUCIA)!.enrolled, false);
  // Desde la copia, Camila sale marcada con la cadencia en la que ya está: su casilla no se puede marcar.
  const desdeCopia = await enLaura((tx) => listEnrollableDeals(tx, copia));
  const camila = desdeCopia.find((x) => x.id === DEAL_FRESKO)!.contacts.find((c) => c.id === CAMILA)!;
  assert.deepEqual([camila.enrolled, camila.liveElsewhere], [false, 'Fresko · plantilla']);
  assert.equal(desdeCopia.find((x) => x.id === DEAL_FRESKO)!.contacts.find((c) => c.id === LUCIA)!.liveElsewhere, null);

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
  const { id: nuevo } = await enLaura((tx) => addStep(tx, id, { stepType: 'email_reply' }));
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

test('proponer otra vez solo reemplaza los pasos con la propuesta de la señal del borrador', async () => {
  const otraSenal = await enLaura(async (tx) =>
    (await tx.query<{ id: string }>(`SELECT id FROM signal WHERE id <> $1::uuid ORDER BY id LIMIT 1`, [SIGNAL_FRESKO])).rows[0]!.id);
  const [borrador, plantilla, propuesta] = await enLaura(async (tx) => {
    const ctx = await getRecommendationContext(tx, SIGNAL_FRESKO);
    const p = recommendSequence(entrada(ctx, CAMILA));
    return [
      await createSequenceFromProposal(tx, { proposal: p, name: 'Fresko · señal', meta: meta(CAMILA) }),
      await createSequenceFromTemplate(tx, 'senal-manual'),
      p,
    ];
  });
  const invalida = (e: unknown) => e instanceof CadenciaError && e.code === 'invalid';
  // Un formulario hecho a mano: el borrador de Fresko con la propuesta de otra señal, o uno sin señal con la de Fresko.
  await assert.rejects(enLaura((tx) => replaceStepsFromProposal(tx, borrador, { proposal: propuesta, meta: { ...meta(CAMILA), signalId: otraSenal } })), invalida);
  await assert.rejects(enLaura((tx) => replaceStepsFromProposal(tx, plantilla, { proposal: propuesta, meta: meta(CAMILA) })), invalida);
  const d = (await enLaura((tx) => getSequenceDetail(tx, borrador)))!;
  assert.equal(d.signal?.id, SIGNAL_FRESKO);
  assert.equal(d.signal?.companyId, COMPANY_FRESKO);
  // Con su propia señal, sí.
  await enLaura((tx) => replaceStepsFromProposal(tx, borrador, { proposal: propuesta, meta: meta(LUCIA) }));
  assert.equal((await enLaura((tx) => getSequenceDetail(tx, borrador)))!.proposal?.contactId, LUCIA);
  // Las personas de la marca de la señal, sin el contexto entero del recomendador.
  const personas = await enLaura((tx) => signalContacts(tx, SIGNAL_FRESKO));
  assert.ok(personas.some((c) => c.id === CAMILA) && personas.some((c) => c.id === LUCIA));
  for (const id of [borrador, plantilla]) await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
});

test('«Añadir paso» con la política llena de mensajes añade un gesto que sí se cumple, no un mensaje que no sale', async () => {
  const id = await enLaura(async (tx) => {
    const ctx = await getRecommendationContext(tx, SIGNAL_FRESKO);
    return createSequenceFromProposal(tx, { proposal: recommendSequence(entrada(ctx, CAMILA)), name: 'Fresko · añadir', meta: meta(CAMILA) });
  });
  const r = await enLaura((tx) => addStep(tx, id));
  assert.equal(r.asGesture, true);
  const d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  const nuevo = d.steps.find((s) => s.id === r.id)!;
  // LinkedIn está permitido y su cuenta existe (aunque pida reconectar): una reacción ahí.
  assert.deepEqual([nuevo.stepType, nuevo.channel, nuevo.angleKey], ['linkedin_like', 'linkedin', 'presencia']);
  assert.match(nuevo.guidanceEs ?? '', /^Hazlo a mano/);
  assert.deepEqual(d.policy.overCap, []);
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));

  // Con sitio en la política, «Añadir paso» sigue siendo el siguiente mensaje del hilo (la plantilla trae 4; se quita uno).
  const corta = await enLaura((tx) => createSequenceFromTemplate(tx, 'senal-manual'));
  const directo = (await enLaura((tx) => getSequenceDetail(tx, corta)))!.steps.find((s) => s.stepType === 'linkedin_message')!;
  await enLaura((tx) => deleteStep(tx, directo.id));
  const r2 = await enLaura((tx) => addStep(tx, corta));
  const n2 = (await enLaura((tx) => getSequenceDetail(tx, corta)))!.steps.find((s) => s.id === r2.id)!;
  assert.deepEqual([r2.asGesture, n2.stepType], [false, 'email_reply']);
  await enLaura((tx) => setSequenceStatus(tx, corta, 'archived'));
});

test('parseSequenceProposal descarta las notas que no tienen la forma de su código', () => {
  const p = parseSequenceProposal({
    version: 1, templateSlug: 'x', signalKind: 'launch', guidance: 'rules', guidanceWhyRules: 'no_key',
    notes: [
      { code: 'template', slug: 'x', match: 'signal' },
      { code: 'rerouted', step: 2, from: 'linkedin', to: 'email', manual: false, reason: 'channel_not_connected' },
      // Otra versión: sin `reason`, con `softened` como texto, un código que no existe, y basura.
      { code: 'rerouted', step: 3, from: 'linkedin', to: 'email', manual: false },
      { code: 'fitted_to_policy', softened: 'prueba_social', dropped: [], shiftedDays: 0, maxTouches: 4, minDays: 3 },
      { code: 'channel_down', channel: 'fax' },
      { code: 'nuevo' },
      null,
      'texto',
      { code: 'no_contact' },
    ],
  });
  assert.deepEqual(p?.notes.map((n) => n.code), ['template', 'rerouted', 'no_contact']);
});

const RESPONDE = /^Responde en el mismo hilo/;

test('reordenar la colaboración: el hilo se rehace y ningún correo nuevo lleva la guía de una respuesta', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'colaboracion-de-un-competidor'));
  const ids = (await enLaura((tx) => getSequenceDetail(tx, id)))!.steps.map((s) => s.id);
  // Bajar el paso 1 (el correo que abre el hilo) al tercer puesto: la respuesta del día 6 queda primera.
  await enLaura((tx) => reorderSteps(tx, id, [ids[1]!, ids[2]!, ids[0]!, ids[3]!]));
  const d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  assert.deepEqual(d.steps.map((s) => [s.id, s.stepType]), [
    [ids[1], 'linkedin_message'], [ids[2], 'email'], [ids[0], 'email_reply'], [ids[3], 'email'],
  ]);
  for (const s of d.steps.filter((x) => x.stepType === 'email')) assert.doesNotMatch(s.guidanceEs ?? '', RESPONDE, s.id);
  // El correo que abría el hilo ahora responde en él, y su guía lo dice.
  assert.match(d.steps[2]!.guidanceEs ?? '', RESPONDE);
  assert.ok(d.steps.every((s) => !s.guidanceStale && s.guidanceWrittenFor === s.stepType));
  // Un solo hilo nuevo antes del cierre (que las plantillas piden como correo nuevo).
  assert.equal(d.steps.filter((s) => s.stepType === 'email' && s.angleKey !== 'sintesis').length, 1);
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
});

test('cambiar el tipo en el editor: la guía que no es de la persona se recompone; la suya se queda y se marca', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'senal-manual'));
  const [correo, directo] = (await enLaura((tx) => getSequenceDetail(tx, id)))!.steps;
  // La guía de la plantilla de un correo pasa a ser la de un directo de LinkedIn.
  await enLaura((tx) => updateStep(tx, correo!.id, { stepType: 'linkedin_message', guidanceEs: correo!.guidanceEs }));
  let d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  const a = d.steps.find((s) => s.id === correo!.id)!;
  assert.match(a.guidanceEs ?? '', /^Mensaje corto con/);
  assert.deepEqual([a.guidanceSource, a.guidanceStale], ['rules', false]);
  // El siguiente correo pasó a abrir el hilo: su guía de respuesta se rehízo.
  const abre = d.steps.find((s) => s.channel === 'email')!;
  assert.equal(abre.stepType, 'email');
  assert.doesNotMatch(abre.guidanceEs ?? '', RESPONDE);

  // La guía que escribió la persona no se pisa: queda marcada para revisarla.
  await enLaura((tx) => updateStep(tx, directo!.id, { guidanceEs: 'Mi mensaje: el video de avena y sus views.' }));
  await enLaura((tx) => updateStep(tx, directo!.id, { stepType: 'email_reply' }));
  d = (await enLaura((tx) => getSequenceDetail(tx, id)))!;
  const b = d.steps.find((s) => s.id === directo!.id)!;
  assert.deepEqual([b.guidanceEs, b.guidanceSource, b.guidanceStale, b.guidanceWrittenFor], [
    'Mi mensaje: el video de avena y sus views.', 'person', true, 'linkedin_message',
  ]);
  // Guardar el paso con su guía, sin cambiar el tipo, es revisarla: el aviso se va.
  await enLaura((tx) => updateStep(tx, directo!.id, { guidanceEs: 'Mi mensaje: el video de avena y sus views.' }));
  assert.equal((await enLaura((tx) => getSequenceDetail(tx, id)))!.steps.find((s) => s.id === directo!.id)!.guidanceStale, false);

  // Cambiar el ángulo de un paso con guía de la plantilla la recompone con el ángulo nuevo.
  const cierre = d.steps.find((s) => s.angleKey === 'sintesis')!;
  await enLaura((tx) => updateStep(tx, cierre.id, { angleKey: 'prueba_social' }));
  const c = (await enLaura((tx) => getSequenceDetail(tx, id)))!.steps.find((s) => s.id === cierre.id)!;
  assert.match(c.guidanceEs ?? '', /resultado medido/);
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
});

test('las guías del cierre piden solo el activo que el paso declara', async () => {
  const tpls = await enLaura((tx) => listSequenceTemplates(tx));
  for (const tpl of tpls) {
    const cierre = tpl.steps.find((s) => s.angle_key === 'sintesis')!;
    assert.ok(cierre, tpl.slug);
    if (cierre.requires_asset === 'media_kit') assert.match(cierre.guidance_es, /enlaza el media kit y, si tienes una cotización pública/, tpl.slug);
    else assert.match(cierre.guidance_es, /enlaza la cotización y, si lo tienes a mano, el media kit/, tpl.slug);
  }
});

test('enrolar: solo llega quien tiene dirección en un canal de mensaje de la cadencia que la política deja', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'colaboracion-de-un-competidor'));
  const fresko = (await enLaura((tx) => listEnrollableDeals(tx, id))).find((x) => x.id === DEAL_FRESKO)!;
  const andres = fresko.contacts.find((c) => c.id === ANDRES)!;
  const camila = fresko.contacts.find((c) => c.id === CAMILA)!;
  // Andrés solo tiene Instagram, que ni está en esta cadencia ni tiene cuenta: no llega.
  assert.deepEqual([andres.hasInstagram, andres.reachChannels, andres.reachable], [true, [], false]);
  assert.deepEqual([camila.reachChannels, camila.reachable], [['email', 'linkedin'], true]);
  const alcance = await enLaura((tx) => reachForSequence(tx, id, [ANDRES, CAMILA, LUCIA]));
  assert.deepEqual([alcance.get(ANDRES), alcance.get(CAMILA), alcance.get(LUCIA)], [[], ['email', 'linkedin'], ['email']]);
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
});

test('la persona por defecto no es la que ya está viva en otra cadencia, y el selector lo sabe', async () => {
  const id = await enLaura((tx) => createSequenceFromTemplate(tx, 'senal-manual', 'Fresko · ocupada'));
  await enLaura((tx) => setSequenceStatus(tx, id, 'active'));
  await enLaura((tx) => enrollContacts(tx, { sequenceId: id, contactIds: [CAMILA], dealId: DEAL_FRESKO }));
  const personas = await enLaura((tx) => signalContacts(tx, SIGNAL_FRESKO));
  assert.equal(personas.find((c) => c.id === CAMILA)!.liveElsewhere, 'Fresko · ocupada');
  assert.equal(personas.find((c) => c.id === LUCIA)!.liveElsewhere, null);
  assert.equal(defaultContact(personas)?.id, LUCIA);
  await enLaura((tx) => setSequenceStatus(tx, id, 'archived'));
  await t.admin(`UPDATE outbound_enrollment SET status = 'completed' WHERE sequence_id = '${id}'`);
});

test('con dos creadores, el nicho y el brief son los del creador del negocio; sin creador, ninguno y la nota lo dice', async () => {
  const OTRA = '00000013-0000-4000-8000-0000000c7e01';
  const BRIEF_OTRA = '00000013-0000-4000-8000-0000000b7e01';
  await t.admin(`
    INSERT INTO creator_profile (id, workspace_id, display_name, niche_slugs)
    VALUES ('${OTRA}', '${WORKSPACE_LAURA}', 'Sara · belleza', '{belleza}');
    INSERT INTO outbound_brief (id, workspace_id, creator_id, title, requires_disclosure, notes, status, updated_at)
    VALUES ('${BRIEF_OTRA}', '${WORKSPACE_LAURA}', '${OTRA}', 'Belleza Q4', false, 'Notas privadas de Sara', 'active', now() + interval '1 day');
  `);
  try {
    const ctx = await enLaura((tx) => getRecommendationContext(tx, SIGNAL_FRESKO));
    // El brief de Sara es más reciente, pero el negocio es de Laura: su nicho, su brief, su divulgación.
    assert.deepEqual([ctx.creator?.id, ctx.nicheSlugs, ctx.brief?.id, ctx.brief?.requiresDisclosure], [LAURA_CREADORA, ['cocina'], BRIEF_LAURA, true]);
    assert.doesNotMatch(JSON.stringify(ctx), /Notas privadas de Sara/);

    await t.admin(`UPDATE deal SET creator_id = NULL WHERE id = '${DEAL_FRESKO}'`);
    const sin = await enLaura((tx) => getRecommendationContext(tx, SIGNAL_FRESKO));
    assert.deepEqual([sin.creator, sin.nicheSlugs, sin.brief, sin.notes], [null, [], null, [{ code: 'no_creator' }]]);
    // Sin nicho, la plantilla es la de la señal para cualquier nicho, no la de cocina ni la de belleza.
    assert.equal(recommendSequence(entrada(sin, CAMILA)).templateSlug, 'marca-con-campana-activa');
  } finally {
    await t.admin(`
      UPDATE deal SET creator_id = '${LAURA_CREADORA}' WHERE id = '${DEAL_FRESKO}';
      DELETE FROM outbound_brief WHERE id = '${BRIEF_OTRA}';
      DELETE FROM creator_profile WHERE id = '${OTRA}';
    `);
  }
});

test('la baja del espacio (el enlace de un correo) cuenta como baja antes de enrolar', async () => {
  assert.equal((await enLaura((tx) => optedOutAmong(tx, [CAMILA, LUCIA]))).size, 0);
  await t.admin(`INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash)
                 VALUES ('${WORKSPACE_LAURA}', 'lucia.parra@fresko.test', repeat('a', 64))`);
  try {
    assert.deepEqual([...(await enLaura((tx) => optedOutAmong(tx, [CAMILA, LUCIA])))], [LUCIA]);
    // La misma expresión que la etiqueta de la pantalla: Lucía sale de baja en «Enrolar desde un negocio».
    const deals = await enLaura((tx) => listEnrollableDeals(tx));
    assert.equal(deals.find((d) => d.id === DEAL_FRESKO)!.contacts.find((c) => c.id === LUCIA)!.optedOut, true);
    // Y la baja es de ESTE espacio: otro no la ve como suya.
    assert.equal((await t.db.withWorkspace(WS_OTRO, (tx) => optedOutAmong(tx, [LUCIA]))).size, 0);
  } finally {
    await t.admin(`DELETE FROM outbound_workspace_optout WHERE email = 'lucia.parra@fresko.test'`);
  }
});

test('un negocio cerrado no se guarda en la propuesta ni recibe a nadie', async () => {
  await t.admin(`UPDATE deal SET stage_id = (SELECT id FROM pipeline_stage WHERE is_lost ORDER BY position LIMIT 1)
                  WHERE id = '${DEAL_FRESKO}'`);
  const ctx = await enLaura((tx) => getRecommendationContext(tx, SIGNAL_FRESKO));
  assert.equal(ctx.deal, null);
  assert.equal(await enLaura((tx) => enrollableContactsOfDeal(tx, DEAL_FRESKO, [CAMILA])).then((x) => x.length), 0);
  assert.ok(!(await enLaura((tx) => listProposableSignals(tx))).signals.some((s) => s.signalId === SIGNAL_FRESKO));
});
