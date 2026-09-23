/**
 * CAM-3 · brand.snapshot: seguidores públicos de la marca de cada campaña
 * en ventana, sobre fixtures. Instagram y YouTube dejan cifra; una marca
 * en dos campañas se lee una vez y deja dos filas; TikTok deja la fila
 * sin cifra con la razón; un handle que no existe o una cuenta personal
 * dejan la razón y no cuentan como fallo; una campaña cerrada o fuera de
 * ventana no se lee; la segunda corrida del día no añade nada; sin
 * credenciales la red se salta; la señal abortada y la cuota agotada no
 * escriben. Ni el token casa ni la API key aparecen en ninguna tabla ni
 * en el log.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnectors, DEFAULT_LIMITS, dumpTextColumns, findSecretInDump, FixtureFetch, InMemoryCallLogSink, InMemorySecretStore, loadFixtures,
  QuotaManager, refresherRegistry, withoutNetwork, type Fixture, type NetworkGuard,
} from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { brandSnapshotJob, type BrandSnapshotPayload } from '../src/jobs/campanas/brand-snapshot.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import type { JobContext } from '../src/runner/registry.ts';
import type { JobDatabase } from '../src/runner/db.ts';
import { jobRuns, startHarness, waitFor, type Harness, type JobRunRow } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-23T07:00:00Z');
const DAY = '2026-09-23';
const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-house-brand-SECRETO', GOOGLE_API_KEY: 'AIza-brand-key-SECRETO' };

const COMPANY = {
  cafe: '00000002-0000-4000-8000-0000000000e1',
  fresko: '00000002-0000-4000-8000-0000000000e2',
  hogar: '00000002-0000-4000-8000-0000000000e3',
  nutrive: '00000002-0000-4000-8000-0000000000e4',
  nadie: '00000002-0000-4000-8000-0000000000e5',
};
const CAM = {
  live: '00000003-0000-4000-8000-0000000ca101',
  live2: '00000003-0000-4000-8000-0000000ca102',
  closed: '00000003-0000-4000-8000-0000000ca103',
  tiktok: '00000003-0000-4000-8000-0000000ca104',
  youtube: '00000003-0000-4000-8000-0000000ca105',
  gone: '00000003-0000-4000-8000-0000000ca106',
  personal: '00000003-0000-4000-8000-0000000ca107',
  future: '00000003-0000-4000-8000-0000000ca108',
  malformada: '00000003-0000-4000-8000-0000000ca109',
};

let h: Harness;
let guard: NetworkGuard;
let fetch: FixtureFetch;

/** El mismo fixture, pero solo para un handle: así el «ok» y el «no existe» conviven en una corrida. */
function forHandle(f: Fixture, handle: string): Fixture {
  return { ...f, request: { ...f.request, urlPattern: `${f.request.urlPattern}${handle}` } };
}

async function seed(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    SELECT set_config('app.workspace_id', '${WORKSPACE}', false);
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE}', 'laura', 'Laura');
    INSERT INTO company (id, name, domain, owner_workspace_id) VALUES
      ('${COMPANY.cafe}', 'Café Alma', 'cafealma.co', '${WORKSPACE}'),
      ('${COMPANY.fresko}', 'Fresko Market', 'freskomarket.co', '${WORKSPACE}'),
      ('${COMPANY.hogar}', 'Hogar Lindo', 'hogarlindo.co', '${WORKSPACE}'),
      ('${COMPANY.nutrive}', 'Nutrivé', 'nutrive.co', '${WORKSPACE}'),
      ('${COMPANY.nadie}', 'Nadie S.A.', 'nadie.co', '${WORKSPACE}');
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, brand_baseline_from, brand_accounts) VALUES
      ('${CAM.live}',     '${WORKSPACE}', '${COMPANY.cafe}',    'Café Alma en curso',     'live',      DATE '2026-09-20', DATE '2026-09-27', DATE '2026-09-06', '[{"platform_id": "instagram", "handle": "cafealma"}]'),
      ('${CAM.live2}',    '${WORKSPACE}', '${COMPANY.cafe}',    'Café Alma, segunda',     'planned',   DATE '2026-10-01', DATE '2026-10-08', DATE '2026-09-17', '[{"platform_id": "instagram", "handle": "@CafeAlma"}]'),
      ('${CAM.closed}',   '${WORKSPACE}', '${COMPANY.hogar}',   'Hogar Lindo cerrada',    'closed',    DATE '2026-09-01', DATE '2026-09-08', DATE '2026-08-18', '[{"platform_id": "instagram", "handle": "hogarlindo"}]'),
      ('${CAM.tiktok}',   '${WORKSPACE}', '${COMPANY.fresko}',  'Fresko en TikTok',       'measuring', DATE '2026-09-02', DATE '2026-09-09', DATE '2026-08-19', '[{"platform_id": "tiktok", "handle": "freskomarket"}]'),
      ('${CAM.youtube}',  '${WORKSPACE}', '${COMPANY.nutrive}', 'Nutrivé en YouTube',     'live',      DATE '2026-09-22', DATE '2026-09-29', DATE '2026-09-08', '[{"platform_id": "youtube", "handle": "NutriveOficial"}]'),
      ('${CAM.gone}',     '${WORKSPACE}', '${COMPANY.nadie}',   'Canal que no existe',    'live',      DATE '2026-09-22', DATE '2026-09-29', DATE '2026-09-08', '[{"platform_id": "youtube", "handle": "nadie"}]'),
      ('${CAM.personal}', '${WORKSPACE}', '${COMPANY.hogar}',   'Cuenta personal',        'live',      DATE '2026-09-22', DATE '2026-09-29', DATE '2026-09-08', '[{"platform_id": "instagram", "handle": "cuentapersonal"}]'),
      ('${CAM.future}',   '${WORKSPACE}', '${COMPANY.cafe}',    'Café Alma en diciembre', 'planned',   DATE '2026-12-01', DATE '2026-12-08', DATE '2026-11-17', '[{"platform_id": "instagram", "handle": "cafealma"}]'),
      -- brand_accounts sin CHECK de tipo: un objeto no puede tumbar la corrida de todos.
      ('${CAM.malformada}', '${WORKSPACE}', '${COMPANY.nadie}', 'Cuentas mal guardadas',  'live',      DATE '2026-09-22', DATE '2026-09-29', DATE '2026-09-08', '{"instagram": "nadie"}');
    SELECT set_config('app.workspace_id', '', false);
  `);
}

interface SnapRow extends Record<string, unknown> {
  campaign_id: string;
  platform_id: string;
  handle: string | null;
  day: string;
  followers: string | number | null;
  media_count: string | number | null;
  source: string;
}

async function snapshots(db: PgliteDatabase): Promise<SnapRow[]> {
  const { rows } = await db.query<SnapRow>(
    'SELECT campaign_id, platform_id, handle, day::text AS day, followers, media_count, source FROM brand_account_snapshot ORDER BY campaign_id, day',
  );
  return rows;
}

async function calls(db: PgliteDatabase): Promise<string[]> {
  const { rows } = await db.query<{ endpoint: string }>('SELECT endpoint FROM api_call_log ORDER BY id');
  return rows.map((r) => r.endpoint);
}

/** Encola una corrida y espera a SU fila de job_run (la siguiente a las que ya había). */
async function correr(harness: Harness, label: string): Promise<JobRunRow> {
  const previas = (await jobRuns(harness.db, 'brand.snapshot')).length;
  await harness.worker.boss.send('brand.snapshot', { source: 'test' });
  return waitFor(async () => {
    const r = (await jobRuns(harness.db, 'brand.snapshot'))[previas];
    return r && r.status !== 'running' ? r : null;
  }, { label, timeoutMs: 60_000 });
}

type Ref = { campaignId: string; platformId: string };
interface Meta {
  day: string;
  campaigns: number;
  targets: number;
  snapshots: Ref[];
  noSource: Ref[];
  errored: Ref[];
  transient: Ref[];
  quota: Ref[];
  writeErrors: Ref[];
  skipped: Record<string, string>;
}
const ids = (refs: Ref[]) => refs.map((r) => r.campaignId).sort();

before(async () => {
  guard = withoutNetwork();
  const [igOk] = await loadFixtures('instagram', [['business_discovery', 'ok']]);
  const [igPersonal] = await loadFixtures('instagram', [['business_discovery', 'personal']]);
  const [ytOk] = await loadFixtures('youtube', [['channels.list', 'handle.ok']]);
  const [ytEmpty] = await loadFixtures('youtube', [['channels.list', 'handle.empty']]);
  fetch = new FixtureFetch([
    forHandle(igOk!, 'cafealma%29'),
    forHandle(igPersonal!, 'cuentapersonal%29'),
    forHandle(ytOk!, 'NutriveOficial'),
    forHandle(ytEmpty!, 'nadie'),
  ]);
  h = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: ENV, http: { fetch: fetch.fetch } });
});
after(async () => { await h.stop(); guard.restore(); });

test('una fila por campaña en ventana: cifra en Instagram y YouTube, razón en TikTok y en las que no se pueden leer; la marca repetida se lee una vez', async () => {
  const run = await correr(h, 'brand.snapshot');
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as unknown as Meta;
  assert.equal(md.day, DAY);
  assert.equal(md.campaigns, 6, 'la cerrada, la de diciembre y la de brand_accounts malformado no cuentan');
  assert.equal(md.targets, 5, '@cafealma en dos campañas es UN objetivo');
  assert.deepEqual(ids(md.snapshots), [CAM.live, CAM.live2, CAM.youtube].sort());
  assert.deepEqual(ids(md.noSource), [CAM.tiktok]);
  assert.deepEqual(ids(md.errored), [CAM.gone, CAM.personal].sort());
  assert.deepEqual(md.transient, []);
  assert.deepEqual(md.quota, []);
  assert.deepEqual(md.writeErrors, []);
  assert.deepEqual(md.skipped, {});
  assert.equal(run.items_processed, 6);
  assert.equal(run.items_failed, 0);

  const rows = await snapshots(h.db);
  assert.equal(rows.length, 6);
  const by = new Map(rows.map((r) => [r.campaign_id, r]));
  for (const id of [CAM.live, CAM.live2]) {
    const r = by.get(id)!;
    assert.equal(Number(r.followers), 267793);
    assert.equal(Number(r.media_count), 1205);
    assert.equal(r.source, 'instagram.business_discovery');
    assert.equal(r.handle, 'cafealma');
    assert.equal(r.day, DAY);
  }
  assert.equal(Number(by.get(CAM.youtube)!.followers), 38400);
  assert.equal(by.get(CAM.youtube)!.source, 'youtube.channels.list');
  assert.deepEqual([by.get(CAM.tiktok)!.followers, by.get(CAM.tiktok)!.source, by.get(CAM.tiktok)!.handle], [null, 'no_public_source', 'freskomarket']);
  assert.deepEqual([by.get(CAM.gone)!.followers, by.get(CAM.gone)!.source], [null, 'not_found']);
  assert.deepEqual([by.get(CAM.personal)!.followers, by.get(CAM.personal)!.source], [null, 'not_discoverable']);
  assert.equal(by.get(CAM.closed), undefined, 'una campaña cerrada no se lee');
  assert.equal(by.get(CAM.future), undefined, 'antes de la línea base no se lee');

  const log = await calls(h.db);
  assert.deepEqual(log.sort(), ['instagram.business_discovery', 'instagram.business_discovery', 'youtube.channels.list', 'youtube.channels.list'], 'una llamada por marca; TikTok no llama');
  assert.equal(guard.attempts, 0);

  const raw = { query: (text: string, params?: readonly unknown[]) => h.db.raw.query(text, params as unknown[]) };
  const dump = await dumpTextColumns(raw, 'public');
  assert.equal(findSecretInDump(dump, [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY]), null);
  const text = h.sink.text();
  for (const s of [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY]) assert.ok(!text.includes(s));
  assert.ok(!JSON.stringify(run.metadata).includes('cafealma'), 'la metadata lleva ids, no handles');
});

test('la segunda corrida del mismo día no añade ni corrige nada: el job es idempotente por día', async () => {
  const antes = await snapshots(h.db);
  const run = await correr(h, 'brand.snapshot, segunda corrida');
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.deepEqual(await snapshots(h.db), antes);
  assert.equal(run.items_processed, 6);
});

test('sin credenciales, Instagram y YouTube se saltan con aviso; TikTok deja su fila igual; nada falla', async () => {
  const h2 = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: {}, http: { fetch: fetch.fetch } });
  try {
    const run = await correr(h2, 'sin credenciales');
    assert.equal(run.status, 'ok', run.error ?? '');
    const md = run.metadata as unknown as Meta;
    assert.match(md.skipped['instagram']!, /INSTAGRAM_HOUSE_TOKEN/);
    assert.match(md.skipped['youtube']!, /GOOGLE_API_KEY/);
    assert.deepEqual(md.snapshots, []);
    assert.deepEqual(ids(md.noSource), [CAM.tiktok]);
    assert.equal((await snapshots(h2.db)).length, 1);
    assert.equal((await calls(h2.db)).length, 0);
    const avisos = h2.sink.text().split('fuente pública sin configurar').length - 1;
    assert.equal(avisos, 2, 'un aviso por red y corrida, no uno por marca');
  } finally {
    await h2.stop();
  }
});

/** Un contexto de job a mano, sobre la base del arnés, para los caminos que pg-boss no deja provocar a voluntad. */
function contexto(overrides: { signal?: AbortSignal; quota?: QuotaManager; db?: JobDatabase }): JobContext {
  const callLog = new InMemoryCallLogSink();
  const quota = overrides.quota ?? new QuotaManager({ now: () => NOW });
  return {
    jobId: 'brand.snapshot', runId: 0, attempt: 1, workspaceId: undefined,
    definition: { id: 'brand.snapshot', labelEs: 'Seguidores de marcas en campaña', queue: 'campaigns', defaultCron: '0 7 * * *', timeoutS: 600, maxAttempts: 5, maxConcurrency: 2, enabled: true },
    db: overrides.db ?? h.db, logger: createLogger({ level: 'debug', sink: new MemorySink() }), signal: overrides.signal ?? new AbortController().signal,
    secrets: new InMemorySecretStore(), refreshers: refresherRegistry([]),
    connectors: createConnectors({ callLog, quota, http: { fetch: fetch.fetch, now: () => NOW } }),
    callLog, now: () => NOW, env: ENV,
  };
}

test('con la señal abortada no llama ni escribe: las marcas quedan como transitorias y pg-boss reintenta', async () => {
  const antes = await snapshots(h.db);
  const r = await brandSnapshotJob.handler({}, contexto({ signal: AbortSignal.abort() }));
  assert.equal(r.processed, 0);
  assert.equal(r.failed, 6);
  assert.equal(r.retry, undefined, 'transitorio: se reintenta');
  assert.deepEqual(await snapshots(h.db), antes);
});

test('con la cuota de YouTube agotada, la marca queda en quota, no se escribe y el job pide no reintentar ya', async () => {
  const antes = await snapshots(h.db);
  const quota = new QuotaManager({
    now: () => NOW,
    limits: { ...DEFAULT_LIMITS, youtube: { ...DEFAULT_LIMITS.youtube, daily: { ...DEFAULT_LIMITS.youtube.daily!, units: 0, persist: false } } },
  });
  const payload: BrandSnapshotPayload = { campaignId: CAM.youtube };
  const r = await brandSnapshotJob.handler(payload, contexto({ quota }));
  const md = r.metadata as unknown as Meta;
  assert.deepEqual(ids(md.quota), [CAM.youtube]);
  assert.equal(r.failed, 1);
  assert.equal(r.retry, false, 'un reintento inmediato no ayuda con la cuota');
  assert.deepEqual(await snapshots(h.db), antes);
});

test('si la base falla al escribir una marca, esa cuenta como transitoria y las demás siguen', async () => {
  const antes = await snapshots(h.db);
  // Una base que rechaza los INSERT de TikTok (como lo haría un disparador o una restricción).
  const db: JobDatabase = {
    query: (text, params) => (/INSERT INTO brand_account_snapshot/.test(text) && params?.[2] === 'tiktok' ? Promise.reject(new Error('fallo simulado de la base')) : h.db.query(text, params)),
    transaction: (fn) => h.db.transaction(fn),
  };
  const r = await brandSnapshotJob.handler({}, contexto({ db }));
  const md = r.metadata as unknown as Meta;
  assert.deepEqual(ids(md.writeErrors), [CAM.tiktok]);
  assert.deepEqual(md.noSource, [], 'TikTok no se anota como hecho si no se guardó');
  assert.equal(r.failed, 1);
  assert.equal(r.retry, undefined, 'un fallo de la base se reintenta');
  assert.deepEqual(ids(md.snapshots), [CAM.live, CAM.live2, CAM.youtube].sort(), 'las demás marcas siguieron');
  assert.deepEqual(await snapshots(h.db), antes, 'el mismo día: nada nuevo, nada corregido');
});
