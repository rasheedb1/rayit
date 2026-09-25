/**
 * VEN-6 dentro de VEN-12 · el pitch a mano con afirmaciones trazables,
 * con la RLS del workspace como la web y el seed de Laura:
 *
 *   · el editor recibe los claims del perfil (mediana, audiencia, videos,
 *     campañas) con su origen, y la política de envío;
 *   · un pitch con una cifra sin claim no se puede programar (el servidor
 *     corre el pre-vuelo otra vez), pero sí guardarse como borrador;
 *   · uno bien hecho sale sin marcas, con sus variables rellenas y con sus
 *     claims en outbound_touch.claims;
 *   · a quien pidió la baja no se le programa nada;
 *   · otro workspace no ve los claims de Laura;
 *   · (ronda 2) guardar y reabrir conserva las marcas [claim:id]; el
 *     negocio tiene que ser de la empresa; el enlace del media kit lo arma
 *     el servidor con el origen de la app; la marca en mayúsculas no es
 *     gritar; pedir un borrador a la IA deja la petición para el worker;
 *     y en una agencia cada creador cita solo sus campañas;
 *   · (ronda 3) las variables no se hornean al guardar (cambia la persona
 *     y cambia el saludo); savePitch dice si el envío está encendido; la
 *     baja de este espacio también frena la redacción; y la demo
 *     embebida redacta en el proceso, por el mismo camino que el worker.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SalesClaim } from '@mc/core/outreach/claims';
import { preflight } from '@mc/core/outreach/preflight';
import { renderTemplate } from '@mc/core/outreach/render';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { loadPitchComposer, outreachWriterStatus, redactRequestedInProcess, requestPitchDraft, savePitch } from '../src/queries/outreach.ts';
import { CAMPAIGN_CAFE_ALMA, openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const CAFE_ALMA = '00000002-0000-4000-8000-0000000000e1';
const CAMILO = '00000002-0000-4000-8000-0000000c0004';
/** La otra persona de Café Alma en el seed. */
const VALENTINA = '00000002-0000-4000-8000-0000000c0003';
const GRANOS = '00000002-0000-4000-8000-0000000000e6';
const MATEO_BAJA = '00000002-0000-4000-8000-0000000c0010';
const OTRO_WS = '00000612-0000-4000-8000-000000000001';

let t: TestDb;
const LOCALE = 'es-CO';

before(async () => {
  t = await openTestDb();
  await t.admin(`INSERT INTO workspace (id, slug, name) VALUES ('${OTRO_WS}', 'pitch-otro', 'Otro espacio')`);
}, SETUP_TIMEOUT);

after(async () => {
  await t?.close();
});

const base = { companyId: CAFE_ALMA, contactId: CAMILO, dealId: null, touchId: null, userId: null, locale: LOCALE };

function pitchWith(claim: SalesClaim, figure: string): string {
  return [
    'Hola {{first_name}},',
    '',
    `Vi el lanzamiento del cold brew en botella de Café Alma y pensé en quien me ve: ${claim.label.toLowerCase()}, ${figure} [claim:${claim.id}].`,
    '',
    'Mis recetas de desayuno se guardan para cocinarlas en la semana, y el café encaja en ese momento sin forzarlo.',
    '',
    '¿Te interesa que te mande una idea de video para el lanzamiento?',
    '',
    'Laura',
  ].join('\n');
}

test('el editor recibe los claims del perfil con su origen y la política', async () => {
  const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE));
  const ids = c.variants['']!.claims.map((x) => x.id);
  assert.ok(ids.includes('baseline:tiktok:median_views'), ids.join(' '));
  assert.ok(ids.some((i) => i.startsWith('audience:tiktok:age:')));
  assert.ok(ids.some((i) => i.startsWith('post:') && i.endsWith(':views_vs_median')));
  assert.ok(ids.some((i) => i.startsWith('campaign:')));
  const mediana = c.variants['']!.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  assert.equal(mediana.ref.table, 'creator_baseline');
  assert.match(mediana.display, /^\d{1,3}(\.\d{3})+$/, 'con los miles del locale');
  assert.equal(c.variants['']!.creator?.name, 'Laura Méndez');
  assert.equal(typeof c.policy.enabled, 'boolean');
  // Una variante por negocio de la empresa, con las cifras de su señal.
  assert.deepEqual(Object.keys(c.variants).sort(), ['', ...c.deals.map((d) => d.id)].sort());
  // Otro espacio no ve el perfil de Laura.
  const otro = await t.db.withWorkspace(OTRO_WS, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE));
  assert.deepEqual([otro.variants['']!.claims.length, otro.variants['']!.creator], [0, null]);
});

test('terminado cuando: un pitch con una cifra sin origen no se puede programar; como borrador, sí', async () => {
  const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE));
  const mediana = c.variants['']!.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  const inventado = pitchWith(mediana, mediana.display).replace(` [claim:${mediana.id}]`, '').replace(mediana.display, '900.000');
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: 'Tu cold brew y mi audiencia', body: inventado, intent: 'schedule', now: new Date() }),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.code === 'preflight' && r.issues!.some((i) => i.code === 'unsourced_figure'));

  const borrador = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: 'Tu cold brew y mi audiencia', body: inventado, intent: 'draft', now: new Date() }),
  );
  assert.ok(borrador.ok && borrador.status === 'draft');
});

test('un pitch bien hecho se programa sin marcas y con sus claims; a quien pidió la baja, no', async () => {
  await t.admin(`UPDATE outbound_policy SET postal_address = 'Calle 93 # 11-26, Bogotá' WHERE workspace_id = '${WORKSPACE_LAURA}'`);
  const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE));
  const mediana = c.variants['']!.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: 'Tu cold brew y mi audiencia', body: pitchWith(mediana, mediana.display), intent: 'schedule', now: new Date() }),
  );
  assert.ok(r.ok && r.status === 'scheduled', JSON.stringify(r));
  const row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    tx.query<{ status: string; body: string; claims: SalesClaim[] }>('SELECT status, body, claims FROM outbound_touch WHERE id = $1', [r.touchId]),
  )).rows[0]!;
  assert.equal(row.status, 'scheduled');
  assert.ok(!row.body.includes('[claim:'));
  assert.ok(row.body.startsWith('Hola Camilo,'), 'las variables se rellenan con la ficha');
  assert.ok(row.body.includes(mediana.display));
  assert.deepEqual(row.claims.map((x) => [x.id, x.ref.table]), [[mediana.id, 'creator_baseline']]);

  const baja = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, companyId: GRANOS, contactId: MATEO_BAJA, subject: 'Una idea para Granos', body: pitchWith(mediana, mediana.display), intent: 'draft', now: new Date() }),
  );
  assert.deepEqual(baja, { ok: false, code: 'opted_out' });
});

const compose = (opts: { appUrl?: string | null } = {}) =>
  t.db.withWorkspace(WORKSPACE_LAURA, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE, opts));
/** Una lectura con la RLS de Laura, como la web. */
const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
  (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<T>(sql))).rows;

test('ida y vuelta: guardar un borrador a mano y reabrirlo conserva las marcas, y el pre-vuelo sigue en verde', async () => {
  const c = await compose();
  const mediana = c.variants['']!.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  // La marca escrita en mayúsculas («CAFÉ ALMA») no es gritar.
  const body = pitchWith(mediana, mediana.display).replace('de Café Alma', 'de CAFÉ ALMA');
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: 'Tu cold brew y mi audiencia', body, intent: 'draft', now: new Date() }),
  );
  assert.ok(r.ok && r.status === 'draft', JSON.stringify(r));
  const again = await compose();
  assert.equal(again.draft?.touchId, r.touchId);
  assert.ok(again.draft!.body.includes(`${mediana.display} [claim:${mediana.id}]`), again.draft!.body);
  // Y sus variables, tal cual las escribió (0058): el editor las rellena según a quién le escribe.
  assert.ok(again.draft!.body.startsWith('Hola {{first_name}},'), again.draft!.body);
  assert.equal(again.draft!.pending, null);
  assert.equal(again.draft!.generationStamp, null, 'lo guardó una persona: no hay sello de la IA');
  const pf = preflight({
    stepType: 'email', subject: again.draft!.subject, body: renderTemplate(again.draft!.body, { first_name: 'Camilo' })!,
    claims: again.variants['']!.claims, firstTouch: true, allowedUppercase: ['Café Alma'],
  });
  assert.ok(pf.ok, JSON.stringify(pf.issues));
  // Y programarlo desde lo reabierto funciona sin volver a insertar ninguna cifra.
  const prog = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, touchId: r.touchId, subject: again.draft!.subject, body: again.draft!.body, intent: 'schedule', now: new Date() }),
  );
  assert.ok(prog.ok && prog.status === 'scheduled', JSON.stringify(prog));
});

test('las variables no se hornean: si el borrador cambia de persona, el saludo cambia con ella', async () => {
  const c = await compose();
  const mediana = c.variants['']!.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  const body = pitchWith(mediana, mediana.display);
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: 'Una idea para {{company}}', body, intent: 'draft', now: new Date() }),
  );
  assert.ok(r.ok, JSON.stringify(r));
  const touchId = r.ok ? r.touchId : '';
  const saved = async () =>
    (await rows<{ subject: string; body: string }>(`SELECT subject, body FROM outbound_touch WHERE id = '${touchId}'`))[0]!;
  assert.ok((await saved()).body.startsWith('Hola Camilo,'));
  assert.equal((await saved()).subject, 'Una idea para Café Alma');
  // La persona reabre el borrador (con sus variables) y lo manda a Valentina: el saludo es para Valentina.
  const reabierto = (await compose()).draft!;
  assert.equal(reabierto.touchId, touchId);
  const otra = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, contactId: VALENTINA, touchId, subject: reabierto.subject, body: reabierto.body, intent: 'draft', now: new Date() }),
  );
  assert.ok(otra.ok, JSON.stringify(otra));
  assert.ok((await saved()).body.startsWith('Hola Valentina,'), (await saved()).body);
  const deNuevo = (await compose()).draft!;
  assert.deepEqual([deNuevo.touchId, deNuevo.contactId, deNuevo.body.startsWith('Hola {{first_name}},')], [touchId, VALENTINA, true]);
});

test('savePitch dice si el envío está encendido; la función de la redacción mira también la baja de este espacio', async () => {
  const c = await compose();
  const mediana = c.variants['']!.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, contactId: VALENTINA, subject: 'Una idea para Café Alma', body: pitchWith(mediana, mediana.display), intent: 'draft', now: new Date() }),
  );
  assert.ok(r.ok && typeof r.sendingEnabled === 'boolean', JSON.stringify(r));
  assert.equal(r.ok && r.sendingEnabled, c.policy.enabled);
  // Valentina pulsa el enlace de baja de un correo de este espacio: ya no se le redacta nada (0058), aunque la llamen directo.
  await t.admin(
    `INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash) VALUES ('${WORKSPACE_LAURA}', 'valentina@cafealma.co', repeat('b', 64))`,
  );
  const touchId = r.ok ? r.touchId : '';
  assert.deepEqual(
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => requestPitchDraft(tx, { touchId, hint: null, instructions: null, userId: null })),
    { ok: false, code: 'opted_out' },
  );
  await t.admin(`DELETE FROM outbound_workspace_optout WHERE workspace_id = '${WORKSPACE_LAURA}' AND email = 'valentina@cafealma.co'`);
});

test('la demo embebida (sin worker) redacta en el proceso lo que pidió la persona, por el mismo camino y con su registro', async () => {
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: null, body: '', intent: 'draft', now: new Date() }),
  );
  assert.ok(r.ok, JSON.stringify(r));
  const touchId = r.ok ? r.touchId : '';
  assert.deepEqual(
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => requestPitchDraft(tx, { touchId, hint: null, instructions: 'Cercano.', userId: null })),
    { ok: true },
  );
  const hecho = await t.db.asWorker((tx) =>
    redactRequestedInProcess(tx, { touchId, generator: createFakeGenerator(), judge: createFakeJudge(), now: new Date() }),
  );
  assert.deepEqual(hecho, { status: 'returned' });
  const touch = (await rows<{ status: string; body: string }>(`SELECT status, body FROM outbound_touch WHERE id = '${touchId}'`))[0]!;
  assert.equal(touch.status, 'draft', 'vuelve a la persona, no se programa solo');
  assert.ok(touch.body.length > 0 && !touch.body.includes('[claim:'), touch.body);
  const g = (await rows<{ stage: string; judge_note: string | null; review_run: number | null }>(
    `SELECT stage, judge_note, review_run FROM outbound_generation WHERE touch_id = '${touchId}'`,
  ))[0]!;
  assert.deepEqual([g.stage, g.review_run], ['reviewed', 1]);
  assert.ok(g.judge_note);
  // Otra vez sin pedido: no hay nada que redactar.
  assert.deepEqual(
    await t.db.asWorker((tx) => redactRequestedInProcess(tx, { touchId, generator: createFakeGenerator(), judge: createFakeJudge(), now: new Date() })),
    { status: 'skipped', code: 'not_requested' },
  );
});

test('el negocio tiene que ser de la empresa; el enlace del media kit lo arma el servidor con el origen de la app', async () => {
  const ajeno = (await rows<{ id: string }>(`SELECT id FROM deal WHERE company_id <> '${CAFE_ALMA}' AND workspace_id = '${WORKSPACE_LAURA}' LIMIT 1`))[0]!;
  const body = 'Hola {{first_name}},\n\nMi media kit: {{media_kit_url}}\n\n¿Te lo reviso contigo?\n\nLaura';
  const otro = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, dealId: ajeno.id, subject: 'Mi media kit para ti', body, intent: 'draft', now: new Date() }),
  );
  assert.deepEqual(otro, { ok: false, code: 'deal' });

  const c = await compose({ appUrl: 'https://on-cue.test/cualquier/ruta' });
  const kit = c.variants['']!.sources.creator?.mediaKitUrl;
  assert.match(kit ?? '', /^https:\/\/on-cue\.test\/kit\/[a-z0-9]+$/);
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: 'Mi media kit para ti', body, intent: 'draft', appUrl: 'https://on-cue.test', now: new Date() }),
  );
  assert.ok(r.ok);
  const row = (await rows<{ body: string }>(`SELECT body FROM outbound_touch WHERE id = '${r.ok ? r.touchId : ''}'`))[0]!;
  assert.ok(row.body.includes(kit!), row.body);
  // Sin origen, o con uno que no es http(s), el hueco queda a la vista: nunca un enlace a otro sitio.
  const sin = await compose({ appUrl: 'javascript:alert(1)' });
  assert.equal(sin.variants['']!.sources.creator?.mediaKitUrl, null);
});

test('«Redactar con IA» deja la petición para el worker; guardar a mano la cancela; el editor sabe si el worker redacta', async () => {
  assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => outreachWriterStatus(tx)), 'unknown');
  await t.admin(`INSERT INTO job_run (job_id, status, finished_at, metadata)
                 VALUES ('outbound.generate', 'ok', now(), '{"writer": "anthropic", "notConfigured": false}')`);
  assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => outreachWriterStatus(tx)), 'anthropic');

  const nuevo = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, subject: null, body: '', intent: 'draft', now: new Date() }),
  );
  assert.ok(nuevo.ok);
  const touchId = nuevo.ok ? nuevo.touchId : '';
  const pedido = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    requestPitchDraft(tx, { touchId, hint: 'shorter', instructions: 'Más cercano.', userId: null }),
  );
  assert.deepEqual(pedido, { ok: true });
  const fila = (await rows<{ stage: string; requested_hint: string; requested_instructions: string }>(
    `SELECT stage, requested_hint, requested_instructions FROM outbound_generation WHERE touch_id = '${touchId}'`,
  ))[0]!;
  assert.deepEqual(fila, { stage: 'requested', requested_hint: 'shorter', requested_instructions: 'Más cercano.' });
  const abierto = await compose();
  assert.equal(abierto.draft?.touchId, touchId);
  assert.deepEqual(abierto.draft?.pending, { stage: 'requested', hint: 'shorter', lastError: null });

  // La persona escribe y guarda mientras espera: su texto manda y la petición se cancela.
  await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, touchId, subject: 'Una idea para Café Alma', body: 'Hola {{first_name}}, lo escribo yo.', intent: 'draft', now: new Date() }),
  );
  const despues = (await rows<{ stage: string; outcome: string }>(`SELECT stage, outcome FROM outbound_generation WHERE touch_id = '${touchId}'`))[0]!;
  assert.deepEqual(despues, { stage: 'reviewed', outcome: 'manual' });

  // Lo que ya salió o se programó no se regenera.
  const programado = (await rows<{ id: string }>(`SELECT id FROM outbound_touch WHERE company_id = '${CAFE_ALMA}' AND status = 'scheduled' LIMIT 1`))[0]!;
  assert.deepEqual(
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => requestPitchDraft(tx, { touchId: programado.id, hint: null, instructions: null, userId: null })),
    { ok: false, code: 'not_editable' },
  );
});

test('en una agencia, cada creador cita solo sus campañas: las de otro no salen como fichas ni pasan el pre-vuelo', async () => {
  const SARA = '00000612-0000-4000-8000-0000000000b2';
  const antes = await compose();
  assert.ok(antes.variants['']!.claims.some((x) => x.id === `campaign:${CAMPAIGN_CAFE_ALMA}:views`), 'la campaña es de Laura');
  await t.admin(`INSERT INTO creator_profile (id, workspace_id, display_name, handle, niche_slugs)
                 VALUES ('${SARA}', '${WORKSPACE_LAURA}', 'Sara Gómez', 'sara.entrena', '{fitness}')`);
  await t.admin(`UPDATE campaign SET creator_id = '${SARA}' WHERE id = '${CAMPAIGN_CAFE_ALMA}'`);
  const deal = (await rows<{ id: string }>(`SELECT id FROM deal WHERE company_id = '${CAFE_ALMA}' ORDER BY created_at LIMIT 1`))[0]!;
  await t.admin(`UPDATE deal SET creator_id = '${SARA}' WHERE id = '${deal.id}'`);

  const c = await compose();
  const laura = c.variants['']!;
  const sara = c.variants[deal.id]!;
  assert.equal(laura.creator?.name, 'Laura Méndez');
  assert.ok(!laura.claims.some((x) => x.id.startsWith(`campaign:${CAMPAIGN_CAFE_ALMA}:`)), 'la campaña de Sara no es de Laura');
  assert.equal(sara.creator?.name, 'Sara Gómez');
  assert.equal(sara.sources.creator?.handle, 'sara.entrena');
  assert.ok(sara.claims.some((x) => x.id === `campaign:${CAMPAIGN_CAFE_ALMA}:views`));
  assert.ok(!sara.claims.some((x) => x.id === 'baseline:tiktok:median_views'), 'la mediana de Laura no es de Sara');

  // Un pitch del negocio de Sara que cita la mediana de Laura no se programa.
  const mediana = laura.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    savePitch(tx, { ...base, dealId: deal.id, subject: 'Tu cold brew y mi audiencia', body: pitchWith(mediana, mediana.display), intent: 'schedule', now: new Date() }),
  );
  assert.ok(!r.ok && r.code === 'preflight' && r.issues!.some((i) => i.code === 'unknown_claim'), JSON.stringify(r));
});
