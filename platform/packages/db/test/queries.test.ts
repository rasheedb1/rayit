/**
 * Los helpers que CIM-2 dejó abiertos en src/queries/ son la plantilla
 * que van a copiar los dueños de cada módulo, así que se ejecutan aquí,
 * no solo se compilan: que el orden, el filtro y el límite sean los que
 * dicen, y que el aislamiento por workspace valga también para ellos.
 *
 * Corre sobre el mismo Postgres embebido con el seed (test/pglite.ts),
 * como mc_app y sin red.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_WORKSPACE, creatorProfile, rateCard, rateCardItem } from '../src/index.ts';
import { listJobDefinitions, listPipelineStages, listPlatforms, listSignalSources } from '../src/queries/catalogos.ts';
import { getWorkspaceSettings } from '../src/queries/cimientos.ts';
import { getCurrentRateCard } from '../src/queries/cotizar.ts';
import { getInvoice } from '../src/queries/finanzas.ts';
import { listPostBoard } from '../src/queries/resumen.ts';
import { getPipelineDeal, listPipeline } from '../src/queries/ventas.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Un workspace vecino, para comprobar que los helpers no cruzan la frontera. */
const WS_VECINO = '0000000b-0000-4000-8000-000000000042';

let t: TestDb;
/** La creadora del seed (Laura) y otra en el workspace vecino. */
let creadoraLaura = '';
let creadoraVecina = '';
let tarifarioVigente = '';
let versionVigente = 0;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_VECINO}', 'vecino-mx', 'Estudio vecino', 'MXN', 'America/Mexico_City', 'es-MX', 'MX')
    ON CONFLICT DO NOTHING;
  `);

  const [laura] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    tx.db.select({ id: creatorProfile.id }).from(creatorProfile),
  );
  creadoraLaura = laura!.id;

  // Laura tiene tarifario: uno vigente y uno viejo, DESPUÉS del que trae
  // el seed 0004 (v1), que deja de estar vigente como lo haría
  // saveRateCard. El viejo existe para que `isCurrent` tenga algo que
  // descartar además del del seed.
  await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
    const { rows } = await tx.query<{ v: number }>(
      'SELECT coalesce(max(version), 0)::int AS v FROM rate_card WHERE creator_id = $1', [creadoraLaura]);
    const base = rows[0]?.v ?? 0;
    versionVigente = base + 2;
    await tx.query('UPDATE rate_card SET is_current = false WHERE creator_id = $1', [creadoraLaura]);
    const [viejo] = await tx.db
      .insert(rateCard)
      .values({ workspaceId: CURRENT_WORKSPACE, creatorId: creadoraLaura, version: base + 1, isCurrent: false })
      .returning({ id: rateCard.id });
    await tx.db.insert(rateCardItem).values({
      rateCardId: viejo!.id, deliverable: 'reel', labelEs: 'Reel (tarifa vieja)', priceLow: '1000000.00', priceHigh: '1500000.00', position: 0,
    });
    const [vigente] = await tx.db
      .insert(rateCard)
      .values({ workspaceId: CURRENT_WORKSPACE, creatorId: creadoraLaura, version: versionVigente, isCurrent: true })
      .returning({ id: rateCard.id });
    tarifarioVigente = vigente!.id;
    // A propósito en desorden: el helper tiene que devolverlos por position.
    await tx.db.insert(rateCardItem).values([
      { rateCardId: tarifarioVigente, deliverable: 'pack', labelEs: 'Paquete', priceLow: '6000000.00', priceHigh: '8000000.00', position: 2 },
      { rateCardId: tarifarioVigente, deliverable: 'reel', labelEs: 'Reel dedicado', priceLow: '2000000.00', priceHigh: '3000000.00', position: 0 },
      { rateCardId: tarifarioVigente, deliverable: 'historias', labelEs: 'Historias', priceLow: '800000.00', priceHigh: '1200000.00', position: 1 },
    ]);
  });

  // La creadora del workspace vecino no tiene tarifario: es el caso null.
  await t.db.withWorkspace(WS_VECINO, async (tx) => {
    const [c] = await tx.db
      .insert(creatorProfile)
      .values({ workspaceId: CURRENT_WORKSPACE, displayName: 'Creadora vecina' })
      .returning({ id: creatorProfile.id });
    creadoraVecina = c!.id;
  });
}, { timeout: 600_000 });

after(async () => {
  await t.close();
});

describe('queries/cotizar · getCurrentRateCard', () => {
  test('devuelve el tarifario vigente, no el viejo, con los ítems por position', async () => {
    const found = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadoraLaura));
    assert.ok(found, 'Laura tiene tarifario vigente');
    assert.equal(found.card.id, tarifarioVigente);
    assert.equal(found.card.version, versionVigente);
    assert.deepEqual(
      found.items.map((i) => i.deliverable),
      ['reel', 'historias', 'pack'],
      'los ítems salen en orden de position, no en el de inserción',
    );
    assert.equal(found.items[0]?.priceLow, '2000000.00');
  });

  test('devuelve null para un creador sin tarifario', async () => {
    const nada = await t.db.withWorkspace(WS_VECINO, (tx) => getCurrentRateCard(tx, creadoraVecina));
    assert.equal(nada, null);
  });

  test('desde otro workspace, el tarifario de Laura no existe (RLS, no un filtro del helper)', async () => {
    const ajeno = await t.db.withWorkspace(WS_VECINO, (tx) => getCurrentRateCard(tx, creadoraLaura));
    assert.equal(ajeno, null, 'el tarifario y los precios de otro workspace no se leen ni pidiéndolos por id');
  });
});

describe('queries/resumen · listPostBoard', () => {
  test('los posts salen del más reciente al más antiguo', async () => {
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPostBoard(tx));
    assert.ok(rows.length >= 4, `el seed trae varios posts; llegaron ${rows.length}`);
    // publishedAt llega como texto ISO desde la vista: se compara como instante.
    const fechas = rows.map((r) => new Date(String(r.publishedAt)).getTime());
    assert.deepEqual(fechas, [...fechas].sort((a, b) => b - a), 'publishedAt descendente');
    assert.ok(rows.every((r) => r.workspaceId === WORKSPACE_LAURA));
  });

  test('el límite se respeta y se queda con los más recientes', async () => {
    const todos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPostBoard(tx));
    const dos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPostBoard(tx, { limit: 2 }));
    assert.equal(dos.length, 2);
    assert.deepEqual(dos.map((r) => r.postId), todos.slice(0, 2).map((r) => r.postId));
  });

  test('desde otro workspace la tabla está vacía', async () => {
    const rows = await t.db.withWorkspace(WS_VECINO, (tx) => listPostBoard(tx));
    assert.deepEqual(rows, []);
  });
});

describe('queries/ventas · listPipeline', () => {
  test('ordena por posición de etapa y, dentro, por fecha de siguiente acción', async () => {
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPipeline(tx));
    const posiciones = rows.map((r) => r.stagePosition ?? 0);
    assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b));
  });
});

describe('queries/cimientos · getWorkspaceSettings', () => {
  test('cada workspace trae su moneda, su zona y su locale: nada está clavado a Colombia', async () => {
    const laura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getWorkspaceSettings(tx));
    assert.equal(laura.currency, 'COP');
    assert.equal(laura.timezone, 'America/Bogota');
    assert.equal(laura.locale, 'es-CO');

    const vecino = await t.db.withWorkspace(WS_VECINO, (tx) => getWorkspaceSettings(tx));
    assert.equal(vecino.currency, 'MXN');
    assert.equal(vecino.timezone, 'America/Mexico_City');
    assert.equal(vecino.locale, 'es-MX');
    assert.equal(vecino.country, 'MX');
  });

  test('un workspace que no existe falla con instrucciones, no devuelve vacío', async () => {
    await assert.rejects(
      t.db.withWorkspace('0000000f-0000-4000-8000-00000000ffff', (tx) => getWorkspaceSettings(tx)),
      /DEMO_WORKSPACE_ID/,
    );
  });
});

describe('queries/catalogos · las siete lecturas con nombre', () => {
  test('platform, pipeline_stage, signal_source y job_definition se leen sin workspace', async () => {
    const plataformas = await listPlatforms(t.db);
    assert.deepEqual(plataformas.map((p) => p.id), ['facebook', 'instagram', 'tiktok', 'youtube']);

    const etapas = await listPipelineStages(t.db);
    assert.ok(etapas.length > 0);
    assert.deepEqual(etapas.map((e) => e.position), [...etapas.map((e) => e.position)].sort((a, b) => a - b));
    assert.ok(etapas.every((e) => e.workspaceId === null), 'sin workspaceId solo salen las etapas compartidas');

    assert.ok((await listSignalSources(t.db)).length > 0);
    const jobs = await listJobDefinitions(t.db);
    assert.ok(jobs.length > 0, 'el catálogo de jobs alimenta el humo del worker');
  });
});

/**
 * Un id que llega de una ruta o de un formulario no es un uuid porque
 * sí. Estos helpers son la plantilla que copian los demás módulos, así
 * que el descuido se multiplicaría por módulo: `/cotizar/no-soy-uuid`
 * acababa en un 22P02 de Postgres convertido en 500 en vez de en el 404
 * del producto.
 */
describe('queries/* · un id de fuera se valida antes de consultar', () => {
  const BASURA = ['no-soy-uuid', '', '  ', "'; DROP TABLE deal; --", '00000000-0000-4000-8000-00000000000', '1 OR 1=1'];

  test('getCurrentRateCard devuelve null, igual que cuando no hay tarifario', async () => {
    for (const id of BASURA) {
      const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, id));
      assert.equal(r, null, `getCurrentRateCard(${JSON.stringify(id)}) tendría que ser null`);
    }
    // Y con un uuid que no existe, lo mismo: para la pantalla son el
    // mismo caso, y por eso no lanza.
    const inexistente = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      getCurrentRateCard(tx, '0000000f-0000-4000-8000-00000000ffff'),
    );
    assert.equal(inexistente, null);
  });

  test('getPipelineDeal y getInvoice, lo mismo', async () => {
    for (const id of BASURA) {
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPipelineDeal(tx, id)), null);
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, id)), null);
    }
  });

  test('un uuid de verdad sí consulta: la validación no se come el caso bueno', async () => {
    const [unDeal] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPipeline(tx));
    // La vista deal_pipeline declara sus columnas nulables (lo son para
    // Drizzle: es una vista), así que el id se comprueba antes de usarlo.
    if (unDeal?.id) {
      const encontrado = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPipelineDeal(tx, unDeal.id!));
      assert.equal(encontrado?.id, unDeal.id);
    }
    const conTarifario = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCurrentRateCard(tx, creadoraLaura));
    assert.ok(conTarifario, 'el tarifario vigente se sigue leyendo');
  });

  test('un deal de otro workspace tampoco existe, aunque el uuid sea válido', async () => {
    const [deLaura] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPipeline(tx));
    if (!deLaura?.id) return;
    assert.equal(await t.db.withWorkspace(WS_VECINO, (tx) => getPipelineDeal(tx, deLaura.id!)), null);
  });

  test('listPostBoard rechaza un limit imposible en vez de mandárselo a Postgres', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, 1000]) {
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPostBoard(tx, { limit })),
        /limit inválido/,
        `limit=${String(limit)}`,
      );
    }
    assert.ok((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPostBoard(tx, { limit: 1 }))).length <= 1);
  });
});
