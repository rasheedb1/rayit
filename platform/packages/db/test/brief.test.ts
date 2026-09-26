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
  addExcludedCompany,
  BriefError,
  briefCompanyVerdictSql,
  countHiddenSignals,
  getActiveBrief,
  getBrief,
  HIDDEN_SIGNALS_SQL,
  listBriefCreators,
  listCategorySuggestions,
  pickBriefCreator,
  saveBrief,
  searchBriefCompanies,
  type SaveBriefInput,
} from '../src/queries/brief.ts';
import {
  countPendingSignals, createSignal, getCompany, getSalesKpis, importSignals, listCompanies, listSignals, rejectSignalBrand,
} from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { membershipSql } from './membresia.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb, WORKSPACE_LAURA } from './pglite.ts';

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
}, SETUP_TIMEOUT);

after(async () => {
  await t.close();
});

describe('VEN-7 · sin brief, el radar no oculta nada', () => {
  test('las seis señales pendientes se ven y no hay brief', async () => {
    assert.deepEqual(await visibles(), [...TODAS].sort());
    const { hidden, pending, brief: b } = await enBrief(async (tx) => ({
      hidden: await countHiddenSignals(tx),
      pending: await countPendingSignals(tx),
      brief: await getBrief(tx, CREADORA),
    }));
    assert.deepEqual(hidden, { total: 0, byCompany: 0, byCategory: 0 });
    assert.equal(pending, 6);
    assert.equal(b, null, 'el brief de Laura (seed) no se ve desde otro workspace');
    const r = await enBrief((tx) => listBriefCreators(tx));
    assert.deepEqual(r, {
      workspaceKind: 'creator',
      creators: [{ id: CREADORA, displayName: 'Creadora del brief', briefStatus: null, briefTitle: null }],
    });
    assert.equal(pickBriefCreator(r.creators, null)?.id, CREADORA, 'sin brief, el creador principal');
  });
});

describe('VEN-7 · una señal de una categoría excluida no aparece en la bandeja', () => {
  test('guardar el brief oculta las de categoría excluida, venga de donde venga la categoría', async () => {
    const id = await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
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
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCategories: ['Alcohol', 'apuestas', 'Suplementos', 'snacks'] })));
    assert.deepEqual(await visibles(), [S_CAFE, S_AROMA].sort());
  });

  test('una empresa excluida oculta sus señales, y el motivo es la empresa', async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: [CO_CAFE] })));
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
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: ['00000009-0000-4000-8000-0000000b7c05'] })));
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    assert.equal(todas.find((s) => s.id === S_AROMA)?.hiddenBy, 'company');
    assert.ok(!(await visibles()).includes(S_AROMA));
  });

  test('un brief en pausa no oculta nada', async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ active: false })));
    assert.deepEqual(await visibles(), [...TODAS].sort());
    const r = await enBrief(async (tx) => ({ activo: await getActiveBrief(tx, CREADORA), editable: await getBrief(tx, CREADORA) }));
    assert.equal(r.activo, null);
    assert.equal(r.editable?.status, 'paused', 'la pantalla lo sigue pudiendo editar y reactivar');
    // Vuelve a estar activo para lo que sigue.
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
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
        CREADORA,
        brief({
          title: '  Marcas   de café  ',
          wantedCategories: ['alimentos', ' Alimentos ', 'cocina', ''],
          wantedCountries: ['co', 'MX', 'CO'],
          excludedCompanyIds: [CO_LICOR, CO_LICOR],
          notes: '  Siempre con código propio. ',
        }),
      ),
    );
    const b = await enBrief((tx) => getBrief(tx, CREADORA));
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
    assert.deepEqual((await enBrief((tx) => getBrief(tx, CREADORA)))?.deliverables, ['tiktok', 'historia'], 'se lee con el nombre del catálogo');

    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ deliverables: ['tiktok', 'historia', 'short'] })));
    const { rows } = await enBrief((tx) =>
      tx.query<{ deliverables: unknown }>('SELECT deliverables FROM outbound_brief WHERE status = $1', ['active']),
    );
    assert.deepEqual(rows[0]?.deliverables, [
      { kind: 'tiktok', label: 'Video de TikTok', price_low: 7100000, price_high: 10600000 },
      { kind: 'historia', label: 'Historia de Instagram (3 pantallas)', price_low: 1600000 },
      { kind: 'short' },
    ]);
    const b = await enBrief((tx) => getBrief(tx, CREADORA));
    assert.deepEqual(b?.deliverables, ['tiktok', 'historia', 'short']);
  });

  test('una categoría no puede estar en «busco» y en «no acepto» a la vez', async () => {
    assert.equal(
      await codigo(enBrief((tx) => saveBrief(tx, CREADORA, brief({ wantedCategories: ['Bienestar'], excludedCategories: ['bienestar'] })))),
      'CategoryConflict:Bienestar',
    );
  });

  test('las empresas excluidas tienen que ser del CRM de este workspace', async () => {
    assert.equal(await codigo(enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: [CO_FUERA] })))), 'CompanyNotInCrm');
    assert.equal(await codigo(enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: ['no-es-un-uuid'] })))), 'CompanyNotInCrm');
  });

  test('lo demás se valida antes de escribir', async () => {
    const casos: [Partial<SaveBriefInput>, string][] = [
      [{ title: '   ' }, 'InvalidTitle'],
      [{ wantedCountries: ['Colombia'] }, 'InvalidCountry:COLOMBIA'],
      [{ minBudget: '-5' }, 'InvalidBudget'],
      [{ minBudget: '12,5' }, 'InvalidBudget'],
      [{ currency: 'pesos' }, 'InvalidCurrency'],
      [{ availabilityFrom: '2026-12-01', availabilityTo: '2026-11-01' }, 'InvalidWindow'],
      [{ availabilityFrom: '2026-02-30' }, 'InvalidWindow'],
      [{ deliverables: ['Reel de 30 s'] }, 'InvalidDeliverable'],
      [{ excludedCategories: Array.from({ length: 31 }, (_, i) => `categoría ${i}`) }, 'TooManyCategories'],
      [{ excludedCategories: ['x'.repeat(61)] }, `InvalidCategory:${'x'.repeat(61)}`],
    ];
    for (const [extra, esperado] of casos) {
      assert.equal(await codigo(enBrief((tx) => saveBrief(tx, CREADORA, brief(extra)))), esperado, JSON.stringify(extra));
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
      empresas: await searchBriefCompanies(tx, 'caf'),
      corta: await searchBriefCompanies(tx, 'c'),
      sinTilde: await searchBriefCompanies(tx, 'MONTANA'),
      fuera: await searchBriefCompanies(tx, 'fuera del'),
    }));
    // «alcohol» está escrita tres veces: «Alcohol» (empresa y brief) y
    // «ALCOHOL» (una señal). Sale una, y no la que grita.
    for (const c of ['Alcohol', 'alimentos', 'cocina', 'suplementos', 'Snacks']) {
      assert.ok(r.categorias.includes(c), `falta ${c} en ${r.categorias.join(', ')}`);
    }
    assert.equal(r.categorias.filter((c) => c.toLowerCase() === 'alcohol').length, 1);
    assert.equal(r.categorias.filter((c) => c.toLowerCase() === 'apuestas').length, 1, 'APUESTAS y apuestas son una');
    assert.ok(r.categorias.includes('apuestas'), 'la que está en minúsculas gana');
    // Las marcas se buscan en el servidor, en todo el CRM (VEN-7 r4): sin tildes ni mayúsculas.
    // «Cafe Aroma S.A.S.» (sin tilde) y «Café Montaña»: las dos empiezan por «caf», y van por nombre.
    assert.deepEqual(r.empresas.map((e) => e.id), ['00000009-0000-4000-8000-0000000b7c05', CO_CAFE]);
    assert.deepEqual(r.sinTilde.map((e) => e.name), ['Café Montaña']);
    assert.deepEqual(r.corta, [], 'con menos de dos letras no busca');
    assert.deepEqual(r.fuera, [], 'solo las del CRM');
  });

  test('más formatos de entregable que el tope no se guardan (BRIEF_LIMITS.deliverables)', async () => {
    const muchos = Array.from({ length: 21 }, (_, i) => `formato_${String.fromCharCode(97 + i)}`);
    assert.equal(await codigo(enBrief((tx) => saveBrief(tx, CREADORA, brief({ deliverables: muchos })))), 'InvalidDeliverable');
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
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
  }, SETUP_TIMEOUT);

  test('una señal manual con solo el nombre de una marca del CRM de categoría excluida no se ve', async () => {
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    const porId = new Map(todas.map((s) => [s.id, s.hiddenBy]));
    assert.equal(porId.get(S_NOMBRE_CRM), 'category', 'por el nicho de Proteína Viva, encontrada por su nombre');
    assert.equal(porId.get(S_NOMBRE_FUERA), null, 'fuera del CRM, el nombre no identifica a la marca');
    assert.ok(!(await visibles()).includes(S_NOMBRE_CRM));
  });

  test('si la marca se excluye por nombre, la señal con solo su nombre sale por la empresa', async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: [CO_SUPLE] })));
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    assert.equal(todas.find((s) => s.id === S_NOMBRE_CRM)?.hiddenBy, 'company');
    assert.equal(todas.find((s) => s.id === S_SUPLE)?.hiddenBy, 'company');
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
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
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: [CO_CAFE] })));
    assert.equal(await veredicto(CO_CAFE, WS_BRIEF), 'company');
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
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
  }, SETUP_TIMEOUT);

  test("un 'member' lo lee pero no lo cambia: la base lo rechaza (0064 §5) y vuelve como Forbidden", async () => {
    const antes = await como(MIEMBRO, (tx) => getBrief(tx, CREADORA));
    assert.ok(antes, 'lo lee todo el espacio');
    await assert.rejects(
      como(MIEMBRO, (tx) => saveBrief(tx, CREADORA, brief({ title: 'Lo cambió un miembro', excludedCategories: [] }))),
      (e: unknown) => e instanceof BriefError && e.code === 'Forbidden',
    );
    const despues = await enBrief((tx) => getBrief(tx, CREADORA));
    assert.equal(despues?.title, antes.title);
    assert.deepEqual(despues?.excludedCategories, antes.excludedCategories, 'lo que oculta a todo el equipo sigue igual');
  });

  test('quien es dueña lo cambia, y queda en audit_log quién, antes y después, en la misma transacción', async () => {
    const id = await como(DUENA, (tx) => saveBrief(tx, CREADORA, brief({ title: 'Marcas de cocina · Q4', excludedCategories: ['Alcohol', 'apuestas'] })));
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
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
  });

  test('dos guardados a la vez en un espacio sin brief crean uno solo, aunque ninguno quede activo', async () => {
    const WS_NUEVO = '00000009-0000-4000-8000-00000000b703';
    const CREADOR_AGENCIA = '00000009-0000-4000-8000-00000000b704';
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind, currency)
      VALUES ('${WS_NUEVO}', 'workspace-brief-ven7-b', 'Otro espacio del brief', 'agency', 'COP') ON CONFLICT DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('${CREADOR_AGENCIA}', '${WS_NUEVO}', 'Creador de la agencia', 'CO') ON CONFLICT DO NOTHING;
    `);
    const enNuevo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_NUEVO, fn);
    // El índice único solo cubre los activos: sin el candado por workspace,
    // dos «en pausa» a la vez leían «no hay ninguno» y creaban dos. Con
    // PGlite las transacciones ya se serializan; con TEST_DATABASE_URL
    // (Postgres de verdad) esto ejercita el candado.
    await Promise.all([
      enNuevo((tx) => saveBrief(tx, CREADOR_AGENCIA, brief({ active: false, title: 'Uno' }))),
      enNuevo((tx) => saveBrief(tx, CREADOR_AGENCIA, brief({ active: false, title: 'Dos' }))),
    ]);
    const { rows } = await enNuevo((tx) => tx.query<{ n: string }>('SELECT count(*)::text AS n FROM outbound_brief'));
    assert.equal(rows[0]?.n, '1');
    const { workspaceKind, creators } = await enNuevo((tx) => listBriefCreators(tx));
    assert.equal(workspaceKind, 'agency');
    assert.deepEqual(creators.map((c) => [c.id, c.briefStatus]), [[CREADOR_AGENCIA, 'paused']]);
  });
});

describe('VEN-7 r2 · con dos creadores, el radar oculta solo lo que ninguno acepta', () => {
  const SARA = '00000009-0000-4000-8000-00000000b705';

  before(async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
    // Sara, del mismo espacio, con su brief activo (uno por creador, 0064 §1): no acepta alcohol ni apuestas.
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('${SARA}', '${WS_BRIEF}', 'Sara · fitness', 'CO') ON CONFLICT DO NOTHING;
      INSERT INTO outbound_brief (workspace_id, creator_id, title, excluded_categories, status)
      VALUES ('${WS_BRIEF}', '${SARA}', 'Fitness', '{alcohol,apuestas}', 'active');
    `);
  }, SETUP_TIMEOUT);
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

describe('VEN-7 r3 · un brief por creador: la pantalla edita el del creador elegido', () => {
  const BETO = '00000009-0000-4000-8000-00000000b706';

  before(async () => {
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('${BETO}', '${WS_BRIEF}', 'Beto · cocina', 'CO') ON CONFLICT DO NOTHING;
    `);
  }, SETUP_TIMEOUT);
  after(async () => {
    await t.admin(`DELETE FROM outbound_brief WHERE creator_id = '${BETO}'; DELETE FROM creator_profile WHERE id = '${BETO}'`);
  });

  test('guardar el de Beto no toca el de la creadora, y cada uno se lee con su creador', async () => {
    const antes = await enBrief((tx) => getBrief(tx, CREADORA));
    assert.equal(await enBrief((tx) => getBrief(tx, BETO)), null, 'Beto todavía no tiene brief');
    await enBrief((tx) => saveBrief(tx, BETO, brief({ title: 'Brief de Beto', excludedCategories: ['harinas'], active: false })));
    const r = await enBrief(async (tx) => ({ suyo: await getBrief(tx, BETO), deElla: await getBrief(tx, CREADORA) }));
    assert.equal(r.suyo?.title, 'Brief de Beto');
    assert.equal(r.suyo?.creatorId, BETO);
    assert.equal(r.deElla?.id, antes?.id);
    assert.equal(r.deElla?.title, antes?.title, 'el de la creadora sigue igual');
    const { creators } = await enBrief((tx) => listBriefCreators(tx));
    assert.deepEqual(
      creators.filter((c) => [CREADORA, BETO].includes(c.id)).map((c) => [c.id, c.briefStatus]),
      [[CREADORA, 'active'], [BETO, 'paused']],
    );
    assert.equal(pickBriefCreator(creators, BETO)?.id, BETO, 'el pedido, si es del espacio');
    assert.equal(pickBriefCreator(creators, '00000000-0000-4000-8000-000000000000')?.id, CREADORA, 'si no, el primero con brief activo');
  });

  test('el creador de otro espacio, o uno que no existe, no se puede escribir', async () => {
    const codigoDe = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof BriefError ? e.code : String(e)));
    assert.equal(await codigoDe(enBrief((tx) => saveBrief(tx, '00000009-0000-4000-8000-00000000b704', brief()))), 'UnknownCreator');
    assert.equal(await codigoDe(enBrief((tx) => saveBrief(tx, 'no-es-un-uuid', brief()))), 'UnknownCreator');
    assert.equal(await enBrief((tx) => getBrief(tx, '00000009-0000-4000-8000-00000000b704')), null, 'ni se lee');
  });
});

describe('VEN-7 r3 · la tarjeta dice qué regla la oculta y cómo encaja con lo que buscas', () => {
  const S_BAJO = '00000009-0000-4000-8000-0000000b75f1';
  const S_USD = '00000009-0000-4000-8000-0000000b75f2';
  const S_MX = '00000009-0000-4000-8000-0000000b75f3';
  const NUEVAS = [S_BAJO, S_USD, S_MX];

  before(async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
    await t.admin(`
      INSERT INTO signal (id, workspace_id, company_id, source_id, headline_es, evidence, fit_score,
                          budget_estimate, budget_currency, dedupe_key, status) VALUES
        -- Café Montaña (alimentos, nicho cocina), en Colombia, con un presupuesto por debajo del mínimo (2 M).
        ('${S_BAJO}', '${WS_BRIEF}', '${CO_CAFE}', 'press_launches', 'Nueva línea de postres', '{"country": "CO"}', 0.99,
         1500000, 'COP', 'ven7:fit-bajo', 'pending'),
        -- Otra moneda: no se compara con el mínimo en pesos.
        ('${S_USD}', '${WS_BRIEF}', '${CO_CAFE}', 'press_launches', 'Campaña regional', '{"country": "CO"}', 0.98,
         500, 'USD', 'ven7:fit-usd', 'pending'),
        -- Manual, en México: fuera de los países del brief (CO).
        ('${S_MX}', '${WS_BRIEF}', NULL, 'manual', 'Abre en Monterrey',
         '{"company_name": "Tacos Norte", "industry": "restaurantes", "country": "mx", "via": "manual"}', 0.97,
         NULL, NULL, 'ven7:fit-mx', 'pending')
      ON CONFLICT DO NOTHING;
    `);
  }, SETUP_TIMEOUT);
  after(async () => {
    await t.admin(`DELETE FROM signal WHERE id IN (${NUEVAS.map((id) => `'${id}'`).join(', ')})`);
  });

  test('el encaje sale en SQL y no oculta nada: bajo tu mínimo, fuera de tus países, la categoría que buscas', async () => {
    const lista = await enBrief((tx) => listSignals(tx));
    const porId = new Map(lista.map((s) => [s.id, s]));
    for (const id of NUEVAS) assert.ok(porId.has(id), `${id} se ve: «Qué buscas» no oculta`);
    assert.deepEqual(porId.get(S_BAJO)?.briefFit, { belowMinBudget: true, countryOutside: false, wantedCategory: 'alimentos', categoryOutside: false });
    assert.deepEqual(porId.get(S_USD)?.briefFit, { belowMinBudget: false, countryOutside: false, wantedCategory: 'alimentos', categoryOutside: false });
    // «restaurantes» no es ninguna de las que busca (alimentos, cocina): «Fuera de lo que buscas» (VEN-7 r4).
    assert.deepEqual(porId.get(S_MX)?.briefFit, { belowMinBudget: false, countryOutside: true, wantedCategory: null, categoryOutside: true });
  });

  test('sin brief activo no marca nada', async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ active: false })));
    try {
      const lista = await enBrief((tx) => listSignals(tx));
      for (const s of lista) {
        assert.deepEqual(s.briefFit, { belowMinBudget: false, countryOutside: false, wantedCategory: null, categoryOutside: false });
      }
    } finally {
      await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
    }
  });

  test('la oculta dice qué regla la dejó fuera: la categoría como se escribió, o la marca', async () => {
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    const match = new Map(todas.map((s) => [s.id, s.hiddenMatch]));
    assert.equal(match.get(S_LICOR), 'Alcohol');
    assert.equal(match.get(S_SUPLE), 'Suplementos');
    assert.equal(match.get(S_APUESTA), 'apuestas');
    assert.equal(match.get(S_CAFE), null, 'la que se ve no lleva regla');

    await enBrief((tx) => saveBrief(tx, CREADORA, brief({ excludedCompanyIds: [CO_CAFE] })));
    try {
      const conMarca = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
      assert.equal(conMarca.find((s) => s.id === S_CAFE)?.hiddenMatch, 'Café Montaña');
    } finally {
      await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
    }
  });

  test('con «Verlas», las ocultas van al final, detrás de todas las que se ven', async () => {
    const todas = await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }));
    const primeraOculta = todas.findIndex((s) => s.hiddenBy !== null);
    assert.ok(primeraOculta > 0, 'hay visibles y ocultas');
    assert.ok(todas.slice(primeraOculta).every((s) => s.hiddenBy !== null), 'ninguna visible después de la primera oculta');
    // Aunque la de licores tenga más encaje (0,90) que varias visibles.
    assert.ok(todas.findIndex((s) => s.id === S_LICOR) > todas.findIndex((s) => s.id === S_AROMA));
  });
});

/** Todos los nodos de un plan de EXPLAIN (FORMAT JSON), en profundidad. */
type NodoDelPlan = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: NodoDelPlan[] };
function nodos(n: NodoDelPlan): NodoDelPlan[] {
  return [n, ...(n.Plans ?? []).flatMap(nodos)];
}

describe('VEN-7 r3 · el veredicto no recorre el catálogo: 2 000 empresas y 100 señales', () => {
  // Un espacio propio. El catálogo compartido (owner_workspace_id NULL) es
  // el que crece con el enriquecimiento del worker y el que ven todos los
  // espacios: hasta la ronda 2, cada señal lo recorría entero (28,6 s con
  // 10 000 empresas y 100 señales).
  //
  // VEN-7 r4: lo que se comprueba es el PLAN, no el reloj. Medir
  // milisegundos dependía de la carga de la máquina (con varios agentes a
  // la vez, una corrida sana pasaba de los topes); el plan no. Con
  // 2 000 empresas y ANALYZE, Postgres ya elige índice si puede: si una
  // búsqueda deja de poder usarlo (una condición no leakproof bajo RLS,
  // 0065), el plan lo dice con un Seq Scan sobre company. La medición de
  // tiempo sigue, pero solo con MC_PERF=1.
  const WS_PERF = '00000009-0000-4000-8000-00000000b7f1';
  const CREADOR_PERF = '00000009-0000-4000-8000-00000000b7f2';
  const enPerf = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_PERF, fn);

  before(async () => {
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind, currency)
      VALUES ('${WS_PERF}', 'workspace-brief-perf', 'Brief a escala', 'creator', 'COP') ON CONFLICT DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('${CREADOR_PERF}', '${WS_PERF}', 'Creador a escala', 'CO') ON CONFLICT DO NOTHING;

      -- Una de cada tres empresas del catálogo es de alcohol.
      INSERT INTO company (name, domain, industry, owner_workspace_id)
      SELECT 'Marca catálogo ' || g, 'catalogo-perf-' || g || '.test', CASE WHEN g % 3 = 0 THEN 'alcohol' ELSE 'moda' END, NULL
        FROM generate_series(1, 2000) g
      ON CONFLICT DO NOTHING;
      -- Las 71..100 están en el CRM del espacio: se reconocen por el nombre.
      INSERT INTO company_link (workspace_id, company_id, relationship)
      SELECT '${WS_PERF}', co.id, 'prospect' FROM company co
       WHERE co.domain IN (SELECT 'catalogo-perf-' || g || '.test' FROM generate_series(71, 100) g)
      ON CONFLICT DO NOTHING;

      -- 40 con empresa, 30 sin empresa pero con dominio, 30 solo con el nombre.
      INSERT INTO signal (workspace_id, company_id, source_id, headline_es, evidence, dedupe_key, status)
      SELECT '${WS_PERF}', co.id, 'meta_ad_library', 'Anuncios ' || g, '{}', 'perf:id:' || g, 'pending'
        FROM generate_series(1, 40) g JOIN company co ON co.domain = ('catalogo-perf-' || g || '.test')::citext;
      INSERT INTO signal (workspace_id, company_id, source_id, headline_es, evidence, dedupe_key, status)
      SELECT '${WS_PERF}', NULL, 'manual', 'Por dominio ' || g,
             jsonb_build_object('company_name', 'Otra ' || g, 'domain', 'CATALOGO-PERF-' || g || '.test'), 'perf:dominio:' || g, 'pending'
        FROM generate_series(41, 70) g;
      INSERT INTO signal (workspace_id, company_id, source_id, headline_es, evidence, dedupe_key, status)
      SELECT '${WS_PERF}', NULL, 'manual', 'Por nombre ' || g,
             jsonb_build_object('company_name', 'MARCA CATALOGO ' || g), 'perf:nombre:' || g, 'pending'
        FROM generate_series(71, 100) g;
      ANALYZE company;
      ANALYZE company_link;
      ANALYZE signal;
    `);
    await enPerf((tx) => saveBrief(tx, CREADOR_PERF, brief({ wantedCategories: [], excludedCategories: ['Alcohol'] })));
  }, SETUP_TIMEOUT);
  after(async () => {
    await t.admin(`
      DELETE FROM workspace WHERE id = '${WS_PERF}';
      DELETE FROM company WHERE owner_workspace_id IS NULL AND domain LIKE 'catalogo-perf-%';
    `);
  });

  test('countHiddenSignals cuenta bien las tres formas de reconocer la marca', async () => {
    // Las de alcohol (múltiplos de 3): 13 por id (3..39), 10 por dominio
    // (42..69) y 10 por nombre (72..99).
    assert.deepEqual(await enPerf((tx) => countHiddenSignals(tx)), { total: 33, byCompany: 0, byCategory: 33 });
    const r = await enPerf(async (tx) => ({ lista: await listSignals(tx), kpis: await getSalesKpis(tx), pendientes: await countPendingSignals(tx) }));
    assert.equal(r.lista.length, 67);
    assert.equal(r.kpis.pendingSignals, 67);
    assert.equal(r.pendientes, 67);
  });

  test('como mc_app, el plan llega a la empresa por sus índices y nunca recorre company entera', async () => {
    const plan = await enPerf(async (tx) => {
      const { rows } = await tx.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${HIDDEN_SIGNALS_SQL}`);
      const crudo = rows[0]?.['QUERY PLAN'];
      const json = (typeof crudo === 'string' ? JSON.parse(crudo) : crudo) as { Plan: NodoDelPlan }[];
      return nodos(json[0]!.Plan);
    });
    const sobreCompany = plan.filter((n) => n['Relation Name'] === 'company');
    assert.ok(sobreCompany.length > 0, 'el veredicto mira la empresa');
    // Toda lectura de company va por un índice: ningún Seq Scan.
    assert.deepEqual(
      sobreCompany.filter((n) => !['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(n['Node Type'])).map((n) => n['Node Type']),
      [],
      'ningún Seq Scan sobre company',
    );
    const indices = new Set(plan.map((n) => n['Index Name']).filter(Boolean));
    const usados = [...indices].join(', ');
    // Por id: la llave primaria. Por dominio: el índice de 0065.
    assert.ok(indices.has('company_pkey'), `por id usa company_pkey (usó: ${usados})`);
    assert.ok(indices.has('company_domain_text_idx'), `por dominio usa company_domain_text_idx (usó: ${usados})`);
    // Por nombre, dentro del CRM: o el de name_key (0065) o, cuando el CRM
    // es chico, la llave de company_link y luego la de company. Las dos
    // son búsquedas por índice; lo que no puede aparecer es el Seq Scan de
    // arriba (hasta la ronda 2, brand_key(co.name) bajo RLS no usaba ninguno).
    assert.ok(
      indices.has('company_name_key_idx') || indices.has('company_link_pkey'),
      `por nombre usa company_name_key_idx o company_link_pkey (usó: ${usados})`,
    );
  });

  test('la medición de tiempo, solo con MC_PERF=1', { skip: process.env.MC_PERF === '1' ? false : 'solo con MC_PERF=1' }, async () => {
    await enPerf((tx) => countHiddenSignals(tx));
    const inicio = performance.now();
    await enPerf(async (tx) => ({ hidden: await countHiddenSignals(tx), lista: await listSignals(tx), kpis: await getSalesKpis(tx) }));
    const ms = performance.now() - inicio;
    assert.ok(ms < 1500, `el conteo, la bandeja y los KPI tardaron ${Math.round(ms)} ms con 2 000 empresas en el catálogo`);
  });
});

describe('VEN-7 r4 · «No aceptar esta marca» desde el radar: la da de alta y la excluye en la misma transacción', () => {
  const S_NUEVA = '00000009-0000-4000-8000-0000000b75a1';
  const S_SIN_MARCA = '00000009-0000-4000-8000-0000000b75a2';
  const S_CLIENTE = '00000009-0000-4000-8000-0000000b75a3';
  const OTRA = '00000009-0000-4000-8000-00000000b707';
  const MIEMBRO = '00000009-0000-4000-8000-0000000b7a02';
  const como = <T>(userId: string, fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS_BRIEF, fn, { userId });
  const codigoDe = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof BriefError ? e.code : String(e)));
  const empresaDe = async (signalId: string) =>
    (await enBrief((tx) => tx.query<{ company_id: string | null }>('SELECT company_id FROM signal WHERE id = $1', [signalId]))).rows[0]
      ?.company_id ?? null;

  before(async () => {
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${MIEMBRO}', 'miembro@brief.test', 'Miembro del brief') ON CONFLICT DO NOTHING;
      ${membershipSql([{ workspaceId: WS_BRIEF, userId: MIEMBRO, kind: 'member' }])}
      INSERT INTO creator_profile (id, workspace_id, display_name, country)
      VALUES ('${OTRA}', '${WS_BRIEF}', 'Otra creadora', 'CO') ON CONFLICT DO NOTHING;
      INSERT INTO signal (id, workspace_id, company_id, source_id, headline_es, evidence, fit_score, dedupe_key, status) VALUES
        -- Una marca que llega por una fuente automática y NO está en el CRM (ni en el catálogo).
        ('${S_NUEVA}', '${WS_BRIEF}', NULL, 'meta_ad_library', 'Anuncios de ropa deportiva',
         '{"company_name": "Ropa Veloz", "domain": "ropaveloz.co", "industry": "moda", "country": "CO"}', 0.66, 'ven7r4:nueva', 'pending'),
        -- Sin empresa y sin nombre: no hay marca que excluir.
        ('${S_SIN_MARCA}', '${WS_BRIEF}', NULL, 'manual', 'Algo sin marca', '{}', 0.10, 'ven7r4:sin-marca', 'pending'),
        -- Una marca que ya está en el CRM (Café Montaña, 'prospect'): su relación no se toca.
        ('${S_CLIENTE}', '${WS_BRIEF}', '${CO_CAFE}', 'press_launches', 'Café Montaña abre en Medellín', '{}', 0.55, 'ven7r4:cliente', 'pending')
      ON CONFLICT DO NOTHING;
    `);
  }, SETUP_TIMEOUT);
  after(async () => {
    await t.admin(`
      DELETE FROM outbound_brief WHERE creator_id = '${OTRA}';
      DELETE FROM creator_profile WHERE id = '${OTRA}';
      DELETE FROM signal WHERE id IN ('${S_NUEVA}', '${S_SIN_MARCA}', '${S_CLIENTE}');
    `);
    await enBrief((tx) => saveBrief(tx, CREADORA, brief()));
  });

  test("un 'member' no puede: Forbidden, y la marca no queda ni en el CRM", async () => {
    assert.equal(await codigoDe(como(MIEMBRO, (tx) => rejectSignalBrand(tx, S_NUEVA))), 'Forbidden');
    assert.equal(await empresaDe(S_NUEVA), null, 'la transacción entera se deshizo');
    const { rows } = await enBrief((tx) => tx.query(`SELECT 1 FROM company WHERE domain = 'ropaveloz.co'`));
    assert.equal(rows.length, 0);
  });

  test('una marca fuera del CRM: nace con la relación blocked, entra al brief y la señal deja de verse', async () => {
    assert.ok((await visibles()).includes(S_NUEVA), 'antes se ve: «moda» no está excluida');
    const r = await enBrief((tx) => rejectSignalBrand(tx, S_NUEVA));
    assert.equal(r.companyName, 'Ropa Veloz');
    assert.equal(r.companyCreated, true);
    assert.deepEqual([r.added, r.briefs, r.hidden], [1, 1, true]);
    assert.equal(await empresaDe(S_NUEVA), r.companyId, 'la señal queda enlazada a la marca');
    const leido = await enBrief(async (tx) => ({
      brief: await getBrief(tx, CREADORA),
      link: (await tx.query<{ relationship: string }>('SELECT relationship FROM company_link WHERE company_id = $1', [r.companyId])).rows,
      traza: (
        await tx.query<{ before: { excluded_companies: string[] }; after: { excluded_companies: string[] } }>(
          `SELECT before, after FROM audit_log WHERE action = 'ventas.brief.excluir_marca' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0],
    }));
    assert.deepEqual(leido.brief?.excludedCompanies, [{ id: r.companyId, name: 'Ropa Veloz' }]);
    assert.deepEqual(leido.link.map((l) => l.relationship), ['blocked']);
    assert.deepEqual(leido.traza?.before.excluded_companies, []);
    assert.deepEqual(leido.traza?.after.excluded_companies, [r.companyId]);
    assert.ok(!(await visibles()).includes(S_NUEVA), 'la bandeja ya no la enseña');
    assert.deepEqual(
      (await enBrief((tx) => listSignals(tx, { brief: 'show_hidden' }))).find((s) => s.id === S_NUEVA)?.hiddenBy,
      'company',
    );
  });

  test('una marca que ya estaba en el CRM conserva su relación; con dos briefs activos, excluirla en uno no la oculta', async () => {
    await enBrief((tx) => saveBrief(tx, OTRA, brief({ title: 'Brief de la otra', excludedCategories: [] })));
    const soloUno = await enBrief((tx) => rejectSignalBrand(tx, S_CLIENTE, { creatorIds: [CREADORA] }));
    assert.deepEqual([soloUno.companyCreated, soloUno.added, soloUno.briefs, soloUno.hidden], [false, 1, 1, false]);
    const link = await enBrief((tx) => tx.query<{ relationship: string }>('SELECT relationship FROM company_link WHERE company_id = $1', [CO_CAFE]));
    assert.deepEqual(link.rows.map((l) => l.relationship), ['prospect'], 'un prospecto no pasa a bloqueado');
    // En todos: la que ya la tenía no cuenta dos veces, y ahora sí se oculta.
    const todos = await enBrief((tx) => rejectSignalBrand(tx, S_CLIENTE));
    assert.deepEqual([todos.added, todos.briefs, todos.hidden], [1, 2, true]);
    const otraVez = await enBrief((tx) => rejectSignalBrand(tx, S_CLIENTE));
    assert.equal(otraVez.added, 0, 'repetirlo no duplica la marca en el brief');
    assert.deepEqual((await enBrief((tx) => getBrief(tx, OTRA)))?.excludedCompanies.map((c) => c.id), [CO_CAFE]);
  });

  test('sin marca, sin brief activo del creador pedido o con una señal que ya no está pendiente, dice por qué', async () => {
    assert.equal(await codigoDe(enBrief((tx) => rejectSignalBrand(tx, S_SIN_MARCA))), 'SignalWithoutBrand');
    assert.equal(await codigoDe(enBrief((tx) => rejectSignalBrand(tx, S_NUEVA, { creatorIds: ['00000009-0000-4000-8000-00000000b7ff'] }))), 'NoActiveBrief');
    assert.equal(await codigoDe(enBrief((tx) => rejectSignalBrand(tx, S_NUEVA, { creatorIds: ['no-es-uuid'] }))), 'UnknownCreator');
    assert.equal(await codigoDe(enBrief((tx) => rejectSignalBrand(tx, '00000009-0000-4000-8000-0000000b75ff'))), 'SignalNotFound');
    assert.equal(await codigoDe(enBrief((tx) => addExcludedCompany(tx, CO_FUERA))), 'CompanyNotInCrm');
  });
});
