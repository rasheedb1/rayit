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
  countHiddenSignals,
  getActiveBrief,
  getBrief,
  getBriefOwner,
  listBriefCompanyOptions,
  listCategorySuggestions,
  saveBrief,
  type SaveBriefInput,
} from '../src/queries/brief.ts';
import { countPendingSignals, createSignal, getSalesKpis, importSignals, listSignals } from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
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
/** Las cinco señales pendientes del seed 0002 de Laura (sección 9). */
const SEED_LAURA_PENDIENTES = ['e007', 'e008', 'e009', 'e010', 'e013'].map((n) => `00000002-0000-4000-8000-00000005${n}`);

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
    assert.deepEqual(owner, { id: CREADORA, displayName: 'Creadora del brief' }, 'sin brief, el creador principal');
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
    // Las cinco pendientes del seed de Laura siguen en su bandeja: su
    // brief (alcohol, apuestas, suplementos) no excluye ninguna, y el de
    // WS_BRIEF no la alcanza.
    for (const id of SEED_LAURA_PENDIENTES) assert.ok(r.ids.includes(id), `falta ${id} en la bandeja de Laura`);
    assert.ok(!r.ids.some((id) => TODAS.includes(id)));
    assert.equal(r.hidden.total, 0);
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
