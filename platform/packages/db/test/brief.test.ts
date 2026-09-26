/**
 * VEN-7 · El brief de outbound contra Postgres embebido: guardarlo y que
 * el radar lo aplique.
 *
 * «Terminado cuando»: una señal de una categoría excluida no aparece en
 * la bandeja. Aquí, además:
 *   - la categoría se reconoce venga de donde venga (el sector de la
 *     empresa, sus nichos, o lo que trae la señal en evidence) y sin
 *     importar tildes ni mayúsculas;
 *   - una empresa excluida oculta sus señales, también las que todavía no
 *     tienen empresa enlazada (por dominio o por nombre);
 *   - la bandeja, el conteo de la pestaña y el KPI dicen lo mismo;
 *   - un brief en pausa no oculta nada, y el de un workspace no toca el
 *     radar de otro.
 *
 * Todo pasa en un workspace propio de esta prueba (WS_BRIEF), sembrado
 * como superusuario: con TEST_DATABASE_URL las pruebas comparten base, y
 * el brief del seed de Laura no se toca.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BriefError,
  briefCompanyVerdictSql,
  countHiddenSignals,
  getActiveBrief,
  getBrief,
  getBriefOwner,
  listBriefCompanyOptions,
  listCategorySuggestions,
  saveBrief,
  type SaveBriefInput,
} from '../src/queries/brief.ts';
import { countPendingSignals, createSignal, getCompany, getSalesKpis, importSignals, listCompanies, listSignals } from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { membershipSql } from './membresia.ts';
import { openTestDb, type TestDb, WORKSPACE_LAURA } from './pglite.ts';

const WS_BRIEF = '00000009-0000-4000-8000-00000000b701';
const CREADORA = '00000009-0000-4000-8000-00000000b702';
const CO_LICOR = '00000009-0000-4000-8000-0000000b7c01';
const CO_CAFE = '00000009-0000-4000-8000-0000000b7c02';
const CO_SUPLE = '00000009-0000-4000-8000-0000000b7c03';
/** Una empresa que NO está en el CRM de WS_BRIEF (sin company_link). */
const CO_FUERA = '00000009-0000-4000-8000-0000000b7c04';

const S_LICOR = '00000009-0000-4000-8000-0000000b75e1';
const S_SNACKS = '00000009-0000-4000-8000-0000000b75e2';
const S_SUPLE = '00000009-0000-4000-8000-0000000b75e3';
const S_APUESTA = '00000009-0000-4000-8000-0000000b75e4';
const S_CAFE = '00000009-0000-4000-8000-0000000b75e5';
const S_AROMA = '00000009-0000-4000-8000-0000000b75e6';
const TODAS = [S_LICOR, S_SNACKS, S_SUPLE, S_APUESTA, S_CAFE, S_AROMA];
/** Las cinco señales pendientes del seed 0002 de Laura (sección 9) que su brief deja ver. */
const SEED_LAURA_PENDIENTES = ['e007', 'e008', 'e009', 'e010', 'e013'].map((n) => `00000002-0000-4000-8000-00000005${n}`);
/** La pendiente del seed de Laura que su brief deja fuera (suplementos, VEN-7 r2): la demo abre con «1 señal oculta». */
const SEED_LAURA_OCULTA = '00000002-0000-4000-8000-00000005e014';

let t: TestDb;
const enBrief = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_BRIEF, fn);
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);

/** Lo mínimo de un brief; cada prueba cambia lo suyo. */
function brief(extra: Partial<SaveBriefInput> = {}): SaveBriefInput {
  return {
    title: 'Marcas de café y cocina',
    wantedCategories: ['alimentos', 'cocina'],
    wantedCountries: ['CO'],
    minBudget: '2000000.00',
    currency: 'COP',
    deliverables: ['reel', 'tiktok'],
    availabilityFrom: '2026-10-01',
    availabilityTo: '2026-12-15',
    excludedCategories: ['Alcohol', 'apuestas', 'Suplementos'],
    excludedCompanyIds: [],
    requiresDisclosure: true,
    notes: null,
    active: true,
    ...extra,
  };
}

const visibles = () => enBrief(async (tx) => (await listSignals(tx)).map((s) => s.id).sort());

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WS_BRIEF}', 'workspace-brief-ven7', 'Workspace del brief', 'creator', 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (id, workspace_id, display_name, country)
    VALUES ('${CREADORA}', '${WS_BRIEF}', 'Creadora del brief', 'CO')
    ON CONFLICT DO NOTHING;

    INSERT INTO company (id, name, domain, country, industry, niche_slugs, owner_workspace_id) VALUES
      ('${CO_LICOR}', 'Licores del Sur', 'licoresdelsur.co', 'CO', 'Alcohol', '{}', '${WS_BRIEF}'),
      ('${CO_CAFE}',  'Café Montaña',    'cafemontana.co',   'CO', 'alimentos', '{cocina}', '${WS_BRIEF}'),
      ('${CO_SUPLE}', 'Proteína Viva',   'proteinaviva.co',  'CO', 'bienestar', '{suplementos}', '${WS_BRIEF}'),
      ('${CO_FUERA}', 'Fuera del CRM',   'fueradelcrm.co',   'CO', 'moda', '{}', '${WS_BRIEF}')
    ON CONFLICT DO NOTHING;
    INSERT INTO company_link (workspace_id, company_id, relationship) VALUES
      ('${WS_BRIEF}', '${CO_LICOR}', 'prospect'),
      ('${WS_BRIEF}', '${CO_CAFE}',  'prospect'),
      ('${WS_BRIEF}', '${CO_SUPLE}', 'prospect')
    ON CONFLICT DO NOTHING;

    INSERT INTO signal (id, workspace_id, company_id, source_id, headline_es, evidence, fit_score, dedupe_key, status) VALUES
      -- El sector de la empresa: «Alcohol».
      ('${S_LICOR}',   '${WS_BRIEF}', '${CO_LICOR}', 'meta_ad_library', '3 anuncios de ron', '{}', 0.90, 'ven7:licor', 'pending'),
      -- La categoría que trae la señal (Meta): «snacks».
      ('${S_SNACKS}',  '${WS_BRIEF}', '${CO_CAFE}',  'meta_ad_library', 'Anuncios de galletas', '{"category": "Snacks"}', 0.85, 'ven7:snacks', 'pending'),
      -- Un nicho de la empresa: «suplementos».
      ('${S_SUPLE}',   '${WS_BRIEF}', '${CO_SUPLE}', 'job_posts', 'Busca creadores fitness', '{}', 0.80, 'ven7:suple', 'pending'),
      -- Manual y sin empresa: el sector escrito al anotarla, con tilde y mayúsculas.
      ('${S_APUESTA}', '${WS_BRIEF}', NULL, 'manual', 'Casa de apuestas nueva',
       '{"company_name": "Apuestas Ya", "industry": "APUESTAS", "via": "manual"}', 0.75, 'ven7:apuesta', 'pending'),
      -- Visibles con el primer brief.
      ('${S_CAFE}',    '${WS_BRIEF}', '${CO_CAFE}',  'press_launches', 'Lanza café en cápsulas', '{}', 0.70, 'ven7:cafe', 'pending'),
      ('${S_AROMA}',   '${WS_BRIEF}', NULL, 'manual', 'Café Aroma abre tienda',
       '{"company_name": "Café Aroma", "domain": "cafearoma.co", "industry": "alimentos", "via": "csv"}', 0.60, 'ven7:aroma', 'pending')
    ON CONFLICT DO NOTHING;
  `);
});

after(async () => {
  await t.close();
});

describe('VEN-7 · sin brief, el radar no oculta nada', () => {
  test('las seis señales pendientes se ven y no hay brief', async () => {
    assert.deepEqual(await visibles(), [...TODAS].sort());
    const { hidden, pending, brief: b } = await enBrief(async (tx) => ({
      hidden: await countHiddenSignals(tx),
      pending: await countPendingSignals(tx),
      brief: await getBrief(tx),
    }));
    assert.deepEqual(hidden, { total: 0, byCompany: 0, byCategory: 0 });
    assert.equal(pending, 6);
    assert.equal(b, null, 'el brief de Laura (seed) no se ve desde otro workspace');
    const owner = await enBrief((tx) => getBriefOwner(tx));
    assert.deepEqual(owner, { id: CREADORA, displayName: 'Creadora del brief', workspaceKind: 'creator' }, 'sin brief, el creador principal');
  });
});

describe('VEN-7 · una señal de una categoría excluida no aparece en la bandeja', () => {
  test('guardar el brief oculta las de categoría excluida, venga de donde venga la categoría', async () => {
    const id = await enBrief((tx) => saveBrief(tx, brief()));
    assert.ok(id);

    // Licores (sector de la empresa), Proteína Viva (nicho) y la manual de
    // apuestas (lo escrito al anotarla, en mayúsculas) quedan fuera.
    assert.deepEqual(await visibles(), [S_SNACKS, S_CAFE, S_AROMA].sort());

    const r = await enBrief(async (tx) => ({
      hidden: await countHiddenSignals(tx),
      pending: await countPendingSignals(tx),
      kpis: await getSalesKpis(tx),
      todas: await listSignals(tx, { brief: 'show_hidden' }),
    }));
    assert.deepEqual(r.hidden, { total: 3, byCompany: 0, byCategory: 3 });
    assert.equal(r.pending, 3, 'la pestaña cuenta lo que la bandeja enseña');
    assert.equal(r.kpis.pendingSignals, 3, 'y el KPI también');
    const porId = new Map(r.todas.map((s) => [s.id, s.hiddenBy]));
    assert.equal(r.todas.length, 6, 'show_hidden las trae todas');
    assert.equal(porId.get(S_LICOR), 'category');
    assert.equal(porId.get(S_SUPLE), 'category');
    assert.equal(porId.get(S_APUESTA), 'category');
    assert.equal(porId.get(S_CAFE), null);
  });

  test('la categoría que trae la señal (evidence.category) también cuenta', async () => {
    await enBrief((tx) => saveBrief(tx, brief({ excludedCategories: ['Alcohol', 'apuestas', 'Suplementos', 'snacks'] })));
    assert.deepEqual(await visibles(), [S_CAFE, S_AROMA].sort());
  });

  test('una empresa excluida oculta sus señales, y el motivo es la empresa', async () => {
    await enBrief((tx) => saveBrief(tx, brief({ excludedCompanyIds: [CO_CAFE] })));
    assert.deepEqual(await visibles(), [S_AROMA]);
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    const porId = new Map(todas.map((s) => [s.id, s.hiddenBy]));
    assert.equal(porId.get(S_CAFE), 'company');
    assert.equal(porId.get(S_SNACKS), 'company', 'la empresa pesa más que la categoría');
    const hidden = await enBrief((tx) => countHiddenSignals(tx));
    assert.deepEqual(hidden, { total: 5, byCompany: 2, byCategory: 3 });
  });

  test('una señal sin empresa enlazada se reconoce por el dominio de la excluida', async () => {
    // Café Aroma entra al CRM con su dominio; la señal manual sigue sin company_id.
    await t.admin(`
      INSERT INTO company (id, name, domain, country, industry, owner_workspace_id)
      VALUES ('00000009-0000-4000-8000-0000000b7c05', 'Cafe Aroma S.A.S.', 'cafearoma.co', 'CO', 'alimentos', '${WS_BRIEF}')
      ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id, relationship)
      VALUES ('${WS_BRIEF}', '00000009-0000-4000-8000-0000000b7c05', 'prospect') ON CONFLICT DO NOTHING;
    `);
    await enBrief((tx) => saveBrief(tx, brief({ excludedCompanyIds: ['00000009-0000-4000-8000-0000000b7c05'] })));
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    assert.equal(todas.find((s) => s.id === S_AROMA)?.hiddenBy, 'company');
    assert.ok(!(await visibles()).includes(S_AROMA));
  });

  test('un brief en pausa no oculta nada', async () => {
    await enBrief((tx) => saveBrief(tx, brief({ active: false })));
    assert.deepEqual(await visibles(), [...TODAS].sort());
    const r = await enBrief(async (tx) => ({ activo: await getActiveBrief(tx), editable: await getBrief(tx) }));
    assert.equal(r.activo, null);
    assert.equal(r.editable?.status, 'paused', 'la pantalla lo sigue pudiendo editar y reactivar');
    // Vuelve a estar activo para lo que sigue.
    await enBrief((tx) => saveBrief(tx, brief()));
  });

  test('anotar a mano o por CSV una marca de categoría excluida entra, pero la bandeja no la enseña y el resultado lo dice', async () => {
    const r = await enBrief((tx) =>
      createSignal(tx, { companyName: 'Cervecería Norte', industry: 'ALCOHOL', headlineEs: 'Patrocina festivales' }),
    );
    assert.ok(r.id);
    assert.equal(r.hiddenBy, 'category');
    assert.ok(!(await visibles()).includes(r.id!));

    const csv = await enBrief((tx) =>
      importSignals(tx, [
        { name: 'Apuestas Rápidas', industry: 'apuestas' },
        { name: 'Panadería Sol', industry: 'alimentos' },
      ]),
    );
    assert.equal(csv.created, 2);
    assert.equal(csv.hiddenByBrief, 1);
  });

  test('el brief de un workspace no toca el radar de otro', async () => {
    const r = await laura(async (tx) => ({ ids: (await listSignals(tx)).map((s) => s.id), hidden: await countHiddenSignals(tx) }));
    // Las cinco pendientes del seed de Laura siguen en su bandeja, y el
    // brief de WS_BRIEF no la alcanza. Su propio brief (alcohol, apuestas,
    // suplementos) deja fuera solo la de suplementos que el seed trae para
    // la demo.
    for (const id of SEED_LAURA_PENDIENTES) assert.ok(r.ids.includes(id), `falta ${id} en la bandeja de Laura`);
    assert.ok(!r.ids.some((id) => TODAS.includes(id)));
    assert.ok(!r.ids.includes(SEED_LAURA_OCULTA));
    assert.deepEqual(r.hidden, { total: 1, byCompany: 0, byCategory: 1 }, 'la demo abre con «1 señal oculta por tu brief»');
  });
});

describe('VEN-7 · guardar el brief', () => {
  /** El código de un BriefError, para comparar sin depender del mensaje. */
  async function codigo(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (err) {
      return err instanceof BriefError ? `${err.code}${err.detail ? `:${err.detail}` : ''}` : String(err);
    }
  }

  test('lo que se guarda es lo que se lee, sin repetidas ni espacios de más', async () => {
    await enBrief((tx) =>
      saveBrief(
        tx,
        brief({
          title: '  Marcas   de café  ',
          wantedCategories: ['alimentos', ' Alimentos ', 'cocina', ''],
          wantedCountries: ['co', 'MX', 'CO'],
          excludedCompanyIds: [CO_LICOR, CO_LICOR],
          notes: '  Siempre con código propio. ',
        }),
      ),
    );
    const b = await enBrief((tx) => getBrief(tx));
    assert.ok(b);
    assert.equal(b.title, 'Marcas de café');
    assert.deepEqual(b.wantedCategories, ['alimentos', 'cocina']);
    assert.deepEqual(b.wantedCountries, ['CO', 'MX']);
    assert.deepEqual(b.excludedCompanies, [{ id: CO_LICOR, name: 'Licores del Sur' }]);
    assert.equal(b.minBudget, '2000000.00');
    assert.equal(b.creatorName, 'Creadora del brief');
    assert.equal(b.notes, 'Siempre con código propio.');
    assert.equal(b.status, 'active');
  });

  test('los entregables que siguen elegidos conservan su rango del tarifario', async () => {
    // «historias» es como lo escribió el seed 0002; el catálogo dice «historia».
    await t.admin(`
      UPDATE outbound_brief
         SET deliverables = '[{"kind": "tiktok", "label": "Video de TikTok", "price_low": 7100000, "price_high": 10600000},
                              {"kind": "historias", "label": "Historia de Instagram (3 pantallas)", "price_low": 1600000}]'
       WHERE workspace_id = '${WS_BRIEF}'`);
    assert.deepEqual((await enBrief((tx) => getBrief(tx)))?.deliverables, ['tiktok', 'historia'], 'se lee con el nombre del catálogo');

    await enBrief((tx) => saveBrief(tx, brief({ deliverables: ['tiktok', 'historia', 'short'] })));
    const { rows } = await enBrief((tx) =>
      tx.query<{ deliverables: unknown }>('SELECT deliverables FROM outbound_brief WHERE status = $1', ['active']),
    );
    assert.deepEqual(rows[0]?.deliverables, [
      { kind: 'tiktok', label: 'Video de TikTok', price_low: 7100000, price_high: 10600000 },
      { kind: 'historia', label: 'Historia de Instagram (3 pantallas)', price_low: 1600000 },
      { kind: 'short' },
    ]);
    const b = await enBrief((tx) => getBrief(tx));
    assert.deepEqual(b?.deliverables, ['tiktok', 'historia', 'short']);
  });

  test('una categoría no puede estar en «busco» y en «no acepto» a la vez', async () => {
    assert.equal(
      await codigo(enBrief((tx) => saveBrief(tx, brief({ wantedCategories: ['Bienestar'], excludedCategories: ['bienestar'] })))),
      'CategoryConflict:Bienestar',
    );
  });

  test('las empresas excluidas tienen que ser del CRM de este workspace', async () => {
    assert.equal(await codigo(enBrief((tx) => saveBrief(tx, brief({ excludedCompanyIds: [CO_FUERA] })))), 'CompanyNotInCrm');
    assert.equal(await codigo(enBrief((tx) => saveBrief(tx, brief({ excludedCompanyIds: ['no-es-un-uuid'] })))), 'CompanyNotInCrm');
  });

  test('lo demás se valida antes de escribir', async () => {
    const casos: [Partial<SaveBriefInput>, string][] = [
      [{ title: '   ' }, 'InvalidTitle'],
      [{ wantedCountries: ['Colombia'] }, 'InvalidCountry:COLOMBIA'],
      [{ minBudget: '-5' }, 'InvalidBudget'],
      [{ minBudget: '12,5' }, 'InvalidBudget'],
      [{ availabilityFrom: '2026-12-01', availabilityTo: '2026-11-01' }, 'InvalidWindow'],
      [{ availabilityFrom: '2026-02-30' }, 'InvalidWindow'],
      [{ deliverables: ['Reel de 30 s'] }, 'InvalidDeliverable'],
      [{ excludedCategories: Array.from({ length: 31 }, (_, i) => `categoría ${i}`) }, 'TooManyCategories'],
      [{ excludedCategories: ['x'.repeat(61)] }, `InvalidCategory:${'x'.repeat(61)}`],
    ];
    for (const [extra, esperado] of casos) {
      assert.equal(await codigo(enBrief((tx) => saveBrief(tx, brief(extra)))), esperado, JSON.stringify(extra));
    }
  });

  test('la base tampoco admite dos briefs activos ni un mínimo negativo', async () => {
    await assert.rejects(
      t.admin(`
        INSERT INTO outbound_brief (workspace_id, creator_id, title, status)
        VALUES ('${WS_BRIEF}', '${CREADORA}', 'Otro activo', 'active')`),
      /outbound_brief_one_active|duplicate key/,
    );
    await assert.rejects(
      t.admin(`UPDATE outbound_brief SET min_budget = -1 WHERE workspace_id = '${WS_BRIEF}'`),
      /outbound_brief_min_budget_nonneg/,
    );
  });

  test('las sugerencias de categoría salen del CRM, las señales y el brief, sin repetir', async () => {
    const r = await enBrief(async (tx) => ({
      categorias: await listCategorySuggestions(tx),
      empresas: await listBriefCompanyOptions(tx),
    }));
    // «alcohol» está escrita tres veces: «Alcohol» (empresa y brief) y
    // «ALCOHOL» (una señal). Sale una, y no la que grita.
    for (const c of ['Alcohol', 'alimentos', 'cocina', 'suplementos', 'Snacks']) {
      assert.ok(r.categorias.includes(c), `falta ${c} en ${r.categorias.join(', ')}`);
    }
    assert.equal(r.categorias.filter((c) => c.toLowerCase() === 'alcohol').length, 1);
    assert.equal(r.categorias.filter((c) => c.toLowerCase() === 'apuestas').length, 1, 'APUESTAS y apuestas son una');
    assert.ok(r.categorias.includes('apuestas'), 'la que está en minúsculas gana');
    assert.ok(r.empresas.some((e) => e.id === CO_CAFE));
    assert.ok(!r.empresas.some((e) => e.id === CO_FUERA), 'solo las del CRM');
  });
});

describe('VEN-7 r2 · la misma marca, se reconozca como se reconozca', () => {
  const S_NOMBRE_CRM = '00000009-0000-4000-8000-0000000b75e7';
  const S_NOMBRE_FUERA = '00000009-0000-4000-8000-0000000b75e8';
  const CO_APUESTAS_FUERA = '00000009-0000-4000-8000-0000000b7c06';

  before(async () => {
    await t.admin(`
      -- Una marca de apuestas que el workspace tiene como ficha propia pero NO en su CRM.
      INSERT INTO company (id, name, domain, country, industry, owner_workspace_id)
      VALUES ('${CO_APUESTAS_FUERA}', 'Apuestas Lejanas', NULL, 'CO', 'apuestas', '${WS_BRIEF}')
      ON CONFLICT DO NOTHING;
      INSERT INTO signal (id, workspace_id, company_id, source_id, headline_es, evidence, fit_score, dedupe_key, status) VALUES
        -- Manual, solo con el nombre (sin dominio ni sector): es Proteína Viva, del CRM, nicho «suplementos».
        ('${S_NOMBRE_CRM}', '${WS_BRIEF}', NULL, 'manual', 'Lanza una proteína vegana',
         '{"company_name": "PROTEINA VIVA", "via": "manual"}', 0.70, 'ven7:nombre-crm', 'pending'),
        -- Solo con el nombre de una marca que no está en el CRM: un nombre no basta.
        ('${S_NOMBRE_FUERA}', '${WS_BRIEF}', NULL, 'manual', 'Abre local',
         '{"company_name": "Apuestas Lejanas", "via": "manual"}', 0.50, 'ven7:nombre-fuera', 'pending')
      ON CONFLICT DO NOTHING;
    `);
    await enBrief((tx) => saveBrief(tx, brief()));
  });

  test('una señal manual con solo el nombre de una marca del CRM de categoría excluida no se ve', async () => {
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    const porId = new Map(todas.map((s) => [s.id, s.hiddenBy]));
    assert.equal(porId.get(S_NOMBRE_CRM), 'category', 'por el nicho de Proteína Viva, encontrada por su nombre');
    assert.equal(porId.get(S_NOMBRE_FUERA), null, 'fuera del CRM, el nombre no identifica a la marca');
    assert.ok(!(await visibles()).includes(S_NOMBRE_CRM));
  });

  test('si la marca se excluye por nombre, la señal con solo su nombre sale por la empresa', async () => {
    await enBrief((tx) => saveBrief(tx, brief({ excludedCompanyIds: [CO_SUPLE] })));
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    assert.equal(todas.find((s) => s.id === S_NOMBRE_CRM)?.hiddenBy, 'company');
    assert.equal(todas.find((s) => s.id === S_SUPLE)?.hiddenBy, 'company');
    await enBrief((tx) => saveBrief(tx, brief()));
  });

  test('la ficha de la empresa cuenta como la bandeja: la oculta no es «1 señal en el radar»', async () => {
    const r = await enBrief(async (tx) => ({
      suple: await getCompany(tx, CO_SUPLE),
      cafe: await getCompany(tx, CO_CAFE),
      lista: await listCompanies(tx),
    }));
    // S_SUPLE es de Proteína Viva (nicho suplementos): oculta.
    assert.equal(r.suple?.pendingSignalCount, 0);
    assert.equal(r.suple?.hiddenSignalCount, 1);
    // Café Montaña: S_SNACKS y S_CAFE se ven (snacks no está excluida en brief()).
    assert.equal(r.cafe?.pendingSignalCount, 2);
    assert.equal(r.cafe?.hiddenSignalCount, 0);
    const enLista = r.lista.find((c) => c.id === CO_SUPLE);
    assert.deepEqual([enLista?.pendingSignalCount, enLista?.hiddenSignalCount], [0, 1], 'la lista dice lo mismo que la ficha');
  });

  test('la regla por EMPRESA (cadencias y despachador) lleva el workspace explícito', async () => {
    const veredicto = (companyId: string, ws: string) =>
      enBrief(async (tx) => {
        const { rows } = await tx.query<{ v: string | null }>(
          `SELECT ${briefCompanyVerdictSql('$1::uuid', '$2::uuid')} AS v`,
          [companyId, ws],
        );
        return rows[0]?.v ?? null;
      });
    assert.equal(await veredicto(CO_LICOR, WS_BRIEF), 'category', 'el sector: Alcohol');
    assert.equal(await veredicto(CO_SUPLE, WS_BRIEF), 'category', 'un nicho: suplementos');
    assert.equal(await veredicto(CO_CAFE, WS_BRIEF), null);
    assert.equal(await veredicto(CO_LICOR, WORKSPACE_LAURA), null, 'el brief de otro espacio no cuenta');
    await enBrief((tx) => saveBrief(tx, brief({ excludedCompanyIds: [CO_CAFE] })));
    assert.equal(await veredicto(CO_CAFE, WS_BRIEF), 'company');
    await enBrief((tx) => saveBrief(tx, brief()));
    // Lo que se compone en el SQL es un alias o un parámetro, nunca texto de fuera.
    assert.throws(() => briefCompanyVerdictSql("x' OR true --", 'ws'), /referencia inválida/);
  });
});

describe('VEN-7 r2 · quién cambia el brief, y la traza', () => {
  const DUENA = '00000009-0000-4000-8000-0000000b7a01';
  const MIEMBRO = '00000009-0000-4000-8000-0000000b7a02';
  const como = <T>(userId: string, fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_BRIEF, fn, { userId });

  before(async () => {
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES
        ('${DUENA}', 'duena@brief.test', 'Dueña del brief'), ('${MIEMBRO}', 'miembro@brief.test', 'Miembro del brief')
      ON CONFLICT DO NOTHING;
      ${membershipSql([
        { workspaceId: WS_BRIEF, userId: DUENA, kind: 'owner' },
        { workspaceId: WS_BRIEF, userId: MIEMBRO, kind: 'member' },
      ])}
    `);
  });

  test("un 'member' lo lee pero no lo cambia: la base lo rechaza (0064 §5) y vuelve como Forbidden", async () => {
    const antes = await como(MIEMBRO, (tx) => getBrief(tx));
    assert.ok(antes, 'lo lee todo el espacio');
    await assert.rejects(
      como(MIEMBRO, (tx) => saveBrief(tx, brief({ title: 'Lo cambió un miembro', excludedCategories: [] }))),
      (e: unknown) => e instanceof BriefError && e.code === 'Forbidden',
    );
    const despues = await enBrief((tx) => getBrief(tx));
    assert.equal(despues?.title, antes.title);
    assert.deepEqual(despues?.excludedCategories, antes.excludedCategories, 'lo que oculta a todo el equipo sigue igual');
  });

  test('quien es dueña lo cambia, y queda en audit_log quién, antes y después, en la misma transacción', async () => {
    const id = await como(DUENA, (tx) => saveBrief(tx, brief({ title: 'Marcas de cocina · Q4', excludedCategories: ['Alcohol', 'apuestas'] })));
    const { rows } = await enBrief((tx) =>
      tx.query<{ actor_user_id: string | null; before: { title: string; excluded_categories: string[] } | null; after: { title: string; excluded_categories: string[]; workspace_id?: string } }>(
        `SELECT actor_user_id, before, after FROM audit_log
          WHERE action = 'ventas.brief.guardar' AND entity_type = 'outbound_brief' AND entity_id = $1
          ORDER BY id DESC LIMIT 1`,
        [id],
      ),
    );
    const traza = rows[0];
    assert.ok(traza, 'hay traza');
    assert.equal(traza.actor_user_id, DUENA);
    assert.deepEqual(traza.before?.excluded_categories, ['Alcohol', 'apuestas', 'Suplementos']);
    assert.equal(traza.after.title, 'Marcas de cocina · Q4');
    assert.deepEqual(traza.after.excluded_categories, ['Alcohol', 'apuestas']);
    assert.equal(traza.after.workspace_id, undefined, 'el workspace ya va en su columna');
    await enBrief((tx) => saveBrief(tx, brief()));
  });

  test('dos guardados a la vez en un espacio sin brief crean uno solo, aunque ninguno quede activo', async () => {
    const WS_NUEVO = '00000009-0000-4000-8000-00000000b703';
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind, currency)
      VALUES ('${WS_NUEVO}', 'workspace-brief-ven7-b', 'Otro espacio del brief', 'agency', 'COP') ON CONFLICT DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('00000009-0000-4000-8000-00000000b704', '${WS_NUEVO}', 'Creador de la agencia', 'CO') ON CONFLICT DO NOTHING;
    `);
    const enNuevo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_NUEVO, fn);
    // El índice único solo cubre los activos: sin el candado por workspace,
    // dos «en pausa» a la vez leían «no hay ninguno» y creaban dos. Con
    // PGlite las transacciones ya se serializan; con TEST_DATABASE_URL
    // (Postgres de verdad) esto ejercita el candado.
    await Promise.all([
      enNuevo((tx) => saveBrief(tx, brief({ active: false, title: 'Uno' }))),
      enNuevo((tx) => saveBrief(tx, brief({ active: false, title: 'Dos' }))),
    ]);
    const { rows } = await enNuevo((tx) => tx.query<{ n: string }>('SELECT count(*)::text AS n FROM outbound_brief'));
    assert.equal(rows[0]?.n, '1');
    const owner = await enNuevo((tx) => getBriefOwner(tx));
    assert.equal(owner?.workspaceKind, 'agency', 'en una agencia la pantalla dice «Brief del espacio»');
  });
});

describe('VEN-7 r2 · con dos creadores, el radar oculta solo lo que ninguno acepta', () => {
  const SARA = '00000009-0000-4000-8000-00000000b705';

  before(async () => {
    await enBrief((tx) => saveBrief(tx, brief()));
    // Sara, del mismo espacio, con su brief activo (uno por creador, 0064 §1): no acepta alcohol ni apuestas.
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('${SARA}', '${WS_BRIEF}', 'Sara · fitness', 'CO') ON CONFLICT DO NOTHING;
      INSERT INTO outbound_brief (workspace_id, creator_id, title, excluded_categories, status)
      VALUES ('${WS_BRIEF}', '${SARA}', 'Fitness', '{alcohol,apuestas}', 'active');
    `);
  });
  after(async () => {
    await t.admin(`DELETE FROM outbound_brief WHERE creator_id = '${SARA}'`);
  });

  test('suplementos se ve (Sara lo acepta); alcohol y apuestas no (ninguna los acepta)', async () => {
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    const porId = new Map(todas.map((s) => [s.id, s.hiddenBy]));
    assert.equal(porId.get(S_SUPLE), null);
    assert.equal(porId.get(S_LICOR), 'category');
    assert.equal(porId.get(S_APUESTA), 'category');
    const r = await enBrief(async (tx) => ({ hidden: await countHiddenSignals(tx), visibles: (await listSignals(tx)).map((s) => s.id) }));
    assert.ok(r.visibles.includes(S_SUPLE));
    assert.equal(r.hidden.total, todas.filter((s) => s.hiddenBy !== null).length, 'la bandeja y el conteo dicen lo mismo');
  });

  test('un creador no puede tener dos briefs activos; dos creadores, sí', async () => {
    await assert.rejects(
      t.admin(`INSERT INTO outbound_brief (workspace_id, creator_id, title, status) VALUES ('${WS_BRIEF}', '${SARA}', 'Otro', 'active')`),
      /outbound_brief_one_active|duplicate key/,
    );
  });
});
