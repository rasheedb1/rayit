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
 *   · otro workspace no ve los claims de Laura.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SalesClaim } from '@mc/core/outreach/claims';
import { loadPitchComposer, savePitch } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const CAFE_ALMA = '00000002-0000-4000-8000-0000000000e1';
const CAMILO = '00000002-0000-4000-8000-0000000c0004';
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
  const ids = c.claims.map((x) => x.id);
  assert.ok(ids.includes('baseline:tiktok:median_views'), ids.join(' '));
  assert.ok(ids.some((i) => i.startsWith('audience:tiktok:age:')));
  assert.ok(ids.some((i) => i.startsWith('post:') && i.endsWith(':views_vs_median')));
  assert.ok(ids.some((i) => i.startsWith('campaign:')));
  const mediana = c.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
  assert.equal(mediana.ref.table, 'creator_baseline');
  assert.match(mediana.display, /^\d{1,3}(\.\d{3})+$/, 'con los miles del locale');
  assert.equal(c.creator?.name, 'Laura Méndez');
  assert.equal(typeof c.policy.enabled, 'boolean');
  // Otro espacio no ve el perfil de Laura.
  const otro = await t.db.withWorkspace(OTRO_WS, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE));
  assert.deepEqual([otro.claims.length, otro.creator], [0, null]);
});

test('terminado cuando: un pitch con una cifra sin origen no se puede programar; como borrador, sí', async () => {
  const c = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => loadPitchComposer(tx, CAFE_ALMA, LOCALE));
  const mediana = c.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
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
  const mediana = c.claims.find((x) => x.id === 'baseline:tiktok:median_views')!;
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
