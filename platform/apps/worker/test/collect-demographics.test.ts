/**
 * CON-7 · collect.demographics sobre respuestas grabadas.
 *
 * Lo que se demuestra aquí, que es lo que la historia promete:
 *   1. Con el fixture de Instagram, audience_breakdown coincide fila a
 *      fila con lo que la API dijo (17 filas, cuatro cortes).
 *   2. Con una cuenta personal de TikTok NO se llama a la API y queda
 *      escrito tt.insights.scope con su message_es en español.
 *   3. Con 99 seguidores en Instagram tampoco se llama: ig.demographics.
 *   4. Una cuenta agregada por @ (CON-10) queda con owner_authorization.
 *   5. Dos workspaces no se cruzan ni en las filas ni en los huecos.
 *   6. La segunda corrida del mismo día no duplica nada ni llama a nadie.
 *   7. Ningún token aparece en ninguna columna de texto ni en el log.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, YOUTUBE_ANALYTICS_SCOPE, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { DEMOGRAPHICS_GROUP } from '../src/jobs/conexiones/prerrequisitos-demografia.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-23T05:20:00Z');
const DAY = '2026-09-23';
const WS_A = '00000007-0000-4000-8000-000000000001';
const WS_B = '00000007-0000-4000-8000-000000000002';
const CREATOR_A = '00000007-0000-4000-8000-00000000000a';
const CREATOR_B = '00000007-0000-4000-8000-00000000000b';

const TOKENS = (tag: string, scopes: string[]) => ({
  accessToken: `act.${tag}-ACCESS-SECRETO`, refreshToken: `rft.${tag}-REFRESH-SECRETO`,
  accessExpiresAt: new Date('2026-10-23T05:00:00Z'), scopes,
});
const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
const TT_BUSINESS_SCOPES = ['user.info.basic', 'user.info.stats', 'user.insights', 'video.insights'];
const TT_PERSONAL_SCOPES = ['user.info.basic', 'user.info.stats', 'video.list'];
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', YOUTUBE_ANALYTICS_SCOPE];

const SECRETOS = [
  ...['ig', 'ig-pocos', 'tt-business', 'tt-personal', 'yt', 'vecina'].flatMap((t) => [TOKENS(t, []).accessToken, TOKENS(t, []).refreshToken]),
];

let h: Harness;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let ids: Record<string, string>;
/** El id de la conexión sembrada con esa clave. Falla ruidosamente si el seed cambió de nombre. */
const id = (clave: string): string => {
  const v = ids[clave];
  if (v === undefined) throw new Error(`La prueba no sembró la cuenta "${clave}"`);
  return v;
};

interface SeedCuenta {
  clave: string;
  workspace: string;
  creator: string;
  platform: string;
  handle: string;
  externalId: string;
  accessMode: string;
  accountType: string;
  scopes: string[];
  secretRef: string;
  /** Seguidores del último snapshot; null = la cuenta nunca se leyó. */
  followers: number | null;
  /** social_connection.status; 'active' si no se dice otra cosa. */
  status?: string;
}

const CUENTAS: SeedCuenta[] = [
  { clave: 'ig', workspace: WS_A, creator: CREATOR_A, platform: 'instagram', handle: 'cafealma', externalId: '17841400000000e01',
    accessMode: 'direct_oauth', accountType: 'business', scopes: IG_SCOPES, secretRef: 'enc:instagram:ig', followers: 412_000 },
  { clave: 'igPocos', workspace: WS_A, creator: CREATOR_A, platform: 'instagram', handle: 'primerosdias', externalId: '17841400000000e02',
    accessMode: 'direct_oauth', accountType: 'business', scopes: IG_SCOPES, secretRef: 'enc:instagram:ig-pocos', followers: 99 },
  { clave: 'ttBusiness', workspace: WS_A, creator: CREATOR_A, platform: 'tiktok', handle: 'laura.cocinafacil', externalId: 'open_id_business_laura',
    accessMode: 'direct_oauth', accountType: 'business', scopes: TT_BUSINESS_SCOPES, secretRef: 'enc:tiktok:tt-business', followers: 412_000 },
  { clave: 'ttPersonal', workspace: WS_A, creator: CREATOR_A, platform: 'tiktok', handle: 'laura.personal', externalId: 'open_id_personal_laura',
    accessMode: 'direct_oauth', accountType: 'personal', scopes: TT_PERSONAL_SCOPES, secretRef: 'enc:tiktok:tt-personal', followers: 5_400 },
  { clave: 'yt', workspace: WS_A, creator: CREATOR_A, platform: 'youtube', handle: 'NutriveOficial', externalId: 'UCnutrive00000000000000e4',
    accessMode: 'direct_oauth', accountType: 'channel', scopes: YT_SCOPES, secretRef: 'enc:youtube:yt', followers: 38_400 },
  { clave: 'porArroba', workspace: WS_A, creator: CREATOR_A, platform: 'instagram', handle: 'selvathegolden', externalId: 'selvathegolden',
    accessMode: 'public_profile', accountType: 'unknown', scopes: [], secretRef: 'public:instagram:selvathegolden', followers: 12_300 },
  { clave: 'vecina', workspace: WS_B, creator: CREATOR_B, platform: 'instagram', handle: 'vecina', externalId: '17841400000000f01',
    accessMode: 'direct_oauth', accountType: 'business', scopes: IG_SCOPES, secretRef: 'enc:instagram:vecina', followers: 80 },
  // Token caído: autorizada en su día, hoy inservible. Sin esto se
  // quedaba fuera del job y su celda vacía no tenía explicación.
  { clave: 'caida', workspace: WS_A, creator: CREATOR_A, platform: 'youtube', handle: 'CanalCaido', externalId: 'UCcaido000000000000000e5',
    accessMode: 'direct_oauth', accountType: 'channel', scopes: YT_SCOPES, secretRef: 'enc:youtube:caida', followers: 9_100,
    status: 'needs_reauth' },
];

async function seed(db: PgliteDatabase): Promise<void> {
  const raw = db.raw;
  await raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WS_A}', 'laura', 'Laura'), ('${WS_B}', 'vecina', 'Vecina');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES
      ('${CREATOR_A}', '${WS_A}', 'Laura'), ('${CREATOR_B}', '${WS_B}', 'Vecina');
  `);
  ids = {};
  for (const c of CUENTAS) {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, account_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10) RETURNING id`,
      [c.workspace, c.creator, c.platform, c.externalId, c.handle, c.secretRef, c.scopes, c.accessMode, c.accountType, c.status ?? 'active'],
    );
    ids[c.clave] = r.rows[0]!.id;
    if (c.followers !== null) {
      await raw.query(
        `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, source)
         VALUES ($1, $2, '2026-09-22'::date, $3, 'api')`,
        [ids[c.clave], c.workspace, c.followers],
      );
    }
  }
}

before(async () => {
  guard = withoutNetwork();
  fetch = new FixtureFetch([
    ...(await loadFixtures('instagram', [['account.demographics', 'age.ok'], ['account.demographics', 'gender.ok'], ['account.demographics', 'country.ok'], ['account.demographics', 'city.ok']])),
    ...(await loadFixtures('youtube', [['analytics.query', 'channel_demographics.ok'], ['analytics.query', 'country.ok']])),
    ...(await loadFixtures('tiktok-accounts', [['business.get', 'ok']])),
  ]);
  h = await startHarness({ jobs: allJobs, now: () => NOW, seed, http: { fetch: fetch.fetch } });
  for (const c of CUENTAS) {
    if (c.accessMode === 'direct_oauth') await h.secrets.set(c.secretRef, TOKENS(c.secretRef.split(':')[2]!, c.scopes));
  }
});
after(async () => { await h.stop(); guard.restore(); });

async function correr(harness: Harness, etiqueta: string): Promise<Record<string, unknown>> {
  const antes = (await jobRuns(harness.db, 'collect.demographics')).length;
  await harness.worker.boss.send('collect.demographics', { source: 'test' });
  const run = await waitFor(
    async () => (await jobRuns(harness.db, 'collect.demographics')).slice(antes).find((r) => r.status !== 'running'),
    { label: etiqueta, timeoutMs: 30_000 },
  );
  assert.equal(run.status, 'ok', run.error ?? '');
  return run.metadata;
}

test('la demografía de las cuentas autorizadas coincide con el fixture, y cada hueco queda explicado', async () => {
  const md = await correr(h, 'collect.demographics') as {
    day: string; saved: string[]; gaps: Record<string, string>; alreadyToday: string[]; errored: string[]; transient: string[];
  };
  assert.equal(md.day, DAY);
  assert.deepEqual([...md.saved].sort(), [id('ig'), id('ttBusiness'), id('yt')].sort());
  assert.deepEqual(md.errored, []);
  assert.deepEqual(md.transient, []);

  // --- 1 · Instagram, fila a fila contra la respuesta grabada --------
  const ig = await h.db.query<{ population: string; dimension: string; bucket: string; share: string | null; absolute: string | null; day: string; scope: string; workspace_id: string }>(
    `SELECT population, dimension, bucket, share::text AS share, absolute::text AS absolute, day::text AS day, scope, workspace_id
       FROM audience_breakdown WHERE connection_id = $1 ORDER BY dimension, bucket`,
    [id('ig')],
  );
  assert.equal(ig.rows.length, 17, 'siete tramos de edad, tres géneros, tres países y cuatro ciudades');
  assert.ok(ig.rows.every((r) => r.scope === 'account' && r.day === DAY && r.population === 'followers' && r.workspace_id === WS_A));
  const edad = ig.rows.filter((r) => r.dimension === 'age');
  assert.deepEqual(edad.map((r) => r.bucket), ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+']);
  assert.deepEqual(edad.map((r) => r.absolute), ['8200', '98000', '164000', '82000', '36000', '15000', '8800']);
  assert.ok(edad.every((r) => r.share === null), 'Instagram da absolutos: share queda en null, no en cero');
  assert.deepEqual(ig.rows.filter((r) => r.dimension === 'gender').map((r) => [r.bucket, r.absolute]), [['F', '288000'], ['M', '115000'], ['U', '9000']]);
  assert.deepEqual(ig.rows.filter((r) => r.dimension === 'country').map((r) => [r.bucket, r.absolute]), [['CO', '350000'], ['MX', '22000'], ['US', '14000']]);
  const ciudades = ig.rows.filter((r) => r.dimension === 'city');
  assert.equal(ciudades.length, 4);
  assert.ok(ciudades.some((r) => r.bucket === 'Bogotá, Bogota' && r.absolute === '141000'), 'la ciudad se guarda tal cual la nombra Meta');

  // --- YouTube: porcentajes que NO suman 1, guardados tal cual -------
  const yt = await h.db.query<{ dimension: string; population: string; bucket: string; share: string | null; absolute: string | null }>(
    `SELECT dimension, population, bucket, share::text AS share, absolute::text AS absolute
       FROM audience_breakdown WHERE connection_id = $1 ORDER BY dimension, bucket`,
    [id('yt')],
  );
  const edadGenero = yt.rows.filter((r) => r.dimension === 'age_gender');
  assert.equal(edadGenero.length, 8);
  assert.ok(edadGenero.every((r) => r.population === 'viewers' && r.absolute === null));
  assert.equal(edadGenero.find((r) => r.bucket === '25-34|F')!.share, '0.279000');
  const suma = edadGenero.reduce((t, r) => t + Number(r.share), 0);
  assert.ok(suma > 0.9 && suma < 0.92, `los share se guardan tal cual y suman ${suma}, no 1`);
  assert.deepEqual(yt.rows.filter((r) => r.dimension === 'country').map((r) => [r.bucket, r.absolute]), [['CO', '31000'], ['MX', '4200'], ['US', '1900']]);

  // --- TikTok Accounts: una llamada, tres dimensiones ---------------
  const tt = await h.db.query<{ dimension: string; bucket: string; share: string | null }>(
    `SELECT dimension, bucket, share::text AS share FROM audience_breakdown WHERE connection_id = $1 ORDER BY dimension, bucket`,
    [id('ttBusiness')],
  );
  assert.deepEqual([...new Set(tt.rows.map((r) => r.dimension))].sort(), ['age', 'country', 'gender']);
  assert.equal(tt.rows.find((r) => r.dimension === 'country' && r.bucket === 'CO')!.share, '0.820000');

  // --- 2, 3 y 4 · los huecos, con su frase en español ---------------
  const gaps = await h.db.query<{ connection_id: string; requirement_id: string; requirement: string; message_es: string; metric_group: string; day: string; workspace_id: string }>(
    `SELECT g.connection_id, g.requirement_id, r.requirement, r.message_es, g.metric_group, g.day::text AS day, g.workspace_id
       FROM metric_gap g JOIN metric_requirement r ON r.id = g.requirement_id ORDER BY g.connection_id`,
  );
  const porCuenta = new Map(gaps.rows.map((g) => [g.connection_id, g]));
  assert.deepEqual([...porCuenta.keys()].sort(), [id('igPocos'), id('ttPersonal'), id('porArroba'), id('vecina'), id('caida')].sort());
  assert.equal(porCuenta.get(id('caida'))!.requirement, 'owner_authorization', 'un token caído se explica, no desaparece');
  assert.match(porCuenta.get(id('caida'))!.message_es, /autorizar/);
  assert.ok(gaps.rows.every((g) => g.metric_group === DEMOGRAPHICS_GROUP && g.day === DAY));

  const personal = porCuenta.get(id('ttPersonal'))!;
  assert.equal(personal.requirement_id, 'tt.audience.account_type');
  assert.equal(personal.requirement, 'business_account');
  assert.match(personal.message_es, /solo existe en cuentas Business/);
  assert.match(personal.message_es, /Creator Rewards/, 'y avisa de lo que cuesta el cambio');
  assert.equal(porCuenta.get(id('igPocos'))!.requirement_id, 'ig.demographics');
  assert.match(porCuenta.get(id('igPocos'))!.message_es, /al menos cien seguidores|cien interacciones/);
  assert.equal(porCuenta.get(id('porArroba'))!.requirement, 'owner_authorization');
  assert.match(porCuenta.get(id('porArroba'))!.message_es, /el dueño tiene que autorizar/);

  // --- ninguna llamada de más ---------------------------------------
  const log = await h.db.query<{ endpoint: string; connection_id: string }>(`SELECT endpoint, connection_id FROM api_call_log ORDER BY id`);
  assert.deepEqual(
    log.rows.map((r) => r.endpoint).sort(),
    ['instagram.account.demographics', 'instagram.account.demographics', 'instagram.account.demographics', 'instagram.account.demographics',
      'tiktok.business.get', 'youtube.analytics.query', 'youtube.analytics.query'],
    'siete llamadas: cuatro cortes de Instagram, una de TikTok y dos de YouTube. Ninguna por una cuenta sin prerrequisito',
  );
  assert.ok(!log.rows.some((r) => [id('ttPersonal'), id('igPocos'), id('porArroba'), id('vecina'), id('caida')].includes(r.connection_id)));
  assert.equal(guard.attempts, 0);

  // --- 5 · dos workspaces, sin cruce --------------------------------
  const cruce = await h.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audience_breakdown a JOIN social_connection c ON c.id = a.connection_id
      WHERE a.workspace_id <> c.workspace_id`,
  );
  assert.equal(cruce.rows[0]!.n, '0', 'cada fila lleva el workspace de SU conexión');
  assert.equal(porCuenta.get(id('vecina'))!.workspace_id, WS_B);
  const deB = await h.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audience_breakdown WHERE workspace_id = $1`, [WS_B]);
  assert.equal(deB.rows[0]!.n, '0', 'la vecina no llegó a tener demografía: su hueco es suyo y las filas de Laura no son suyas');

  // --- 7 · ni un token en las tablas ni en el log -------------------
  const raw = { query: (text: string, params?: readonly unknown[]) => h.db.raw.query(text, params as unknown[]) };
  assert.equal(findSecretInDump(await dumpTextColumns(raw, 'public'), SECRETOS), null);
  const texto = h.sink.text();
  for (const s of SECRETOS) assert.ok(!texto.includes(s), `el log filtró ${s.slice(0, 12)}…`);
});

test('la segunda corrida del mismo día no duplica ni una fila, y no llama a nadie', async () => {
  const antes = fetch.calls.length;
  const filasAntes = await h.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audience_breakdown`);
  // El hueco de la cuenta personal lleva abierto desde el 3 de septiembre.
  await h.db.query(`UPDATE metric_gap SET day = '2026-09-03', detected_at = '2026-09-03T05:20:00Z' WHERE connection_id = $1`, [id('ttPersonal')]);

  const md = await correr(h, 'segunda corrida') as { saved: string[]; alreadyToday: string[]; gaps: Record<string, string> };
  assert.deepEqual(md.saved, [], 'no se guarda nada nuevo');
  assert.deepEqual([...md.alreadyToday].sort(), [id('ig'), id('ttBusiness'), id('yt')].sort());
  assert.equal(fetch.calls.length, antes, 'cero llamadas: la demografía de hoy ya estaba');
  const filasDespues = await h.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audience_breakdown`);
  assert.equal(filasDespues.rows[0]!.n, filasAntes.rows[0]!.n);

  // `day` es DESDE cuándo falta, no la última vez que se miró: pisarlo
  // cada mañana convertiría «desde hace tres semanas» en «desde hoy».
  const g = await h.db.query<{ day: string; detected_at: string }>(
    `SELECT day::text AS day, detected_at::text AS detected_at FROM metric_gap WHERE connection_id = $1`, [id('ttPersonal')]);
  assert.equal(g.rows[0]!.day, '2026-09-03');
  assert.ok(g.rows[0]!.detected_at > '2026-09-03', 'pero la última comprobación sí se mueve');
});

test('una corrida que se cortó a medias la completa la siguiente, y solo pide lo que falta', async () => {
  // Como si el cuarto corte de Instagram no hubiera llegado: los otros
  // tres sí se guardaron, y eso NO puede dar el día por hecho.
  await h.db.query(`DELETE FROM audience_breakdown WHERE connection_id = $1 AND dimension = 'city'`, [id('ig')]);
  const antes = fetch.calls.length;
  const filasOtras = await h.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audience_breakdown WHERE connection_id = $1 AND dimension <> 'city'`, [id('ig')]);

  const md = await correr(h, 'completar lo que falta') as { saved: string[]; alreadyToday: string[] };
  assert.deepEqual(md.saved, [id('ig')]);
  assert.ok(!md.alreadyToday.includes(id('ig')), 'tener «algo» del día no es tenerlo todo');
  assert.equal(fetch.calls.length - antes, 1, 'una sola llamada: el corte que faltaba, no los cuatro');

  const ciudad = await h.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audience_breakdown WHERE connection_id = $1 AND dimension = 'city'`, [id('ig')]);
  assert.equal(ciudad.rows[0]!.n, '4', 'y las ciudades vuelven a estar');
  const otras = await h.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audience_breakdown WHERE connection_id = $1 AND dimension <> 'city'`, [id('ig')]);
  assert.equal(otras.rows[0]!.n, filasOtras.rows[0]!.n, 'sin duplicar ni una de las que ya estaban');
});

test('lo que la plataforma contesta: una tabla vacía no es un dato, y «faltan seguidores» no es un fallo', async () => {
  // Dos cuentas en UN arnés (abrir otro cuesta minuto y medio de
  // migraciones): los fixtures no chocan porque son hosts distintos.
  const CANAL = '00000007-0000-4000-8000-0000000000e1';
  const NUEVA = '00000007-0000-4000-8000-0000000000c1';
  const dos = async (db: PgliteDatabase) => {
    await db.raw.exec(`
      INSERT INTO workspace (id, slug, name) VALUES ('${WS_A}', 'laura', 'Laura');
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR_A}', '${WS_A}', 'Laura');
      INSERT INTO social_connection (id, workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, account_type) VALUES
        ('${CANAL}', '${WS_A}', '${CREATOR_A}', 'youtube', 'UCcasinuevo0000000000001', 'casinuevo', 'enc:youtube:vacio',
         '{https://www.googleapis.com/auth/youtube.readonly,${YOUTUBE_ANALYTICS_SCOPE}}', 'direct_oauth', 'channel'),
        -- Sin snapshot de seguidores: no sabemos cuántos tiene, y eso no
        -- es «menos de cien». Se llama, y Meta contesta con el subcódigo.
        ('${NUEVA}', '${WS_A}', '${CREATOR_A}', 'instagram', '17841400000000e09', 'reciencreada', 'enc:instagram:nueva',
         '{instagram_business_basic,instagram_business_manage_insights}', 'direct_oauth', 'business');
    `);
  };
  const [vacio] = await loadFixtures('youtube', [['analytics.query', 'demographics.empty']]);
  const h2 = await startHarness({
    jobs: allJobs, now: () => NOW, seed: dos,
    http: { fetch: new FixtureFetch([
      // El fixture de la tabla vacía se grabó con filtro de video; aquí
      // vale para cualquier consulta de Analytics de este canal.
      { ...vacio!, request: { ...vacio!.request, urlPattern: '^https://youtubeanalytics\\.googleapis\\.com/v2/reports' } },
      ...(await loadFixtures('instagram', [['account.demographics', 'insufficient']])),
    ]).fetch },
  });
  await h2.secrets.set('enc:youtube:vacio', TOKENS('vacio', YT_SCOPES));
  await h2.secrets.set('enc:instagram:nueva', TOKENS('nueva', IG_SCOPES));
  try {
    const md = await correr(h2, 'respuestas de la plataforma') as {
      saved: string[]; empty: string[]; gaps: Record<string, string>; errored: string[]; transient: string[];
    };
    assert.deepEqual(md.saved, []);
    assert.deepEqual(md.errored, [], 'ni un requisito ni una tabla vacía son un fallo');
    assert.deepEqual(md.transient, []);

    // --- YouTube: tabla vacía (el canal tiene pocas vistas) ----------
    assert.deepEqual(md.empty, [CANAL]);
    const filas = await h2.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audience_breakdown`);
    assert.equal(filas.rows[0]!.n, '0', 'sin filas no se inventa una fila vacía');

    // --- Instagram: el subcódigo 2108006 se traduce a su requisito ---
    assert.deepEqual(md.gaps, { [NUEVA]: 'ig.demographics' });
    const g = await h2.db.query<{ connection_id: string; requirement_id: string; message_es: string }>(
      `SELECT g.connection_id, g.requirement_id, r.message_es FROM metric_gap g JOIN metric_requirement r ON r.id = g.requirement_id`,
    );
    assert.equal(g.rows.length, 1, 'el canal sin filas NO deja hueco: no le falta ningún requisito');
    assert.equal(g.rows[0]!.connection_id, NUEVA);
    assert.match(g.rows[0]!.message_es, /cien seguidores/);

    const llamadas = await h2.db.query<{ endpoint: string }>(`SELECT endpoint FROM api_call_log ORDER BY id`);
    const ig = llamadas.rows.filter((r) => r.endpoint === 'instagram.account.demographics');
    assert.equal(ig.length, 1, 'se corta en el primer corte: no se piden los otros tres');
  } finally {
    await h2.stop();
  }
});
