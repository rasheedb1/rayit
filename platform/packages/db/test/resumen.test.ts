/**
 * Las consultas del módulo Resumen (RES-1) y la escritura de la
 * importación por CSV (RES-2), contra el Postgres embebido con el seed
 * y sin red, como mc_app.
 *
 * Lo que se prueba aquí y no en la pantalla: que los números salgan de
 * SQL y no de React, que el filtro por red y el periodo cambien lo que
 * tienen que cambiar, que un workspace sin datos devuelva NULL —y no
 * ceros—, que un workspace que SOLO importó CSV vea cifras, y que
 * importar no mueva ni diluya lo que ya había.
 *
 * Las fechas de las filas importadas son RELATIVAS a hoy: con fechas
 * fijas, estas pruebas caducarían en cuanto el calendario dejase el
 * mes de la siembra fuera de la ventana de 30 días.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import {
  bucketStep,
  countPosts,
  CsvImportError,
  ensureCsvConnection,
  getFollowersByPlatform,
  getFreshnessByConnection,
  getResumenCoverage,
  getResumenKpis,
  getViewsByBucket,
  importCsvReadings,
  lastLabelOnGrid,
  listExternalPostIds,
  listImportableAccounts,
  type CsvImportErrorCode,
  type CsvReading,
} from '../src/queries/resumen.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Un workspace vecino, vacío salvo su creador: el estado "sin datos" tiene que ser NULL, no cero. */
const WS_VECINO = '0000000c-0000-4000-8000-000000000042';
/** Otro vecino, este SOLO con lo que deja una importación por CSV (RES-2). */
const WS_SOLO_CSV = '0000000c-0000-4000-8000-000000000043';
/** Un tercero, con un creador borrado más antiguo que el vivo. */
const WS_CREADOR_BORRADO = '0000000c-0000-4000-8000-000000000044';
const CREADOR_BORRADO = '0000000c-0000-4000-8000-0000000000b1';
const CREADOR_VIVO = '0000000c-0000-4000-8000-0000000000b2';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  // Los vecinos llevan creador: sin él, `importCsvReadings` moriría por
  // falta de creador y la prueba de aislamiento pasaría por el motivo
  // equivocado, sin llegar a comprobar la conexión ajena.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_VECINO}',          'vecino-resumen',  'Estudio vecino',   'COP', 'America/Bogota', 'es-CO', 'CO'),
           ('${WS_SOLO_CSV}',        'vecino-solo-csv', 'Estudio de CSVs',  'COP', 'America/Bogota', 'es-CO', 'CO'),
           ('${WS_CREADOR_BORRADO}', 'vecino-borrado',  'Estudio borrado',  'COP', 'America/Bogota', 'es-CO', 'CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (workspace_id, display_name, handle)
    VALUES ('${WS_VECINO}',   'Vecino',   'vecino'),
           ('${WS_SOLO_CSV}', 'Solo CSV', 'solo.csv')
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (id, workspace_id, display_name, handle, created_at, deleted_at)
    VALUES ('${CREADOR_BORRADO}', '${WS_CREADOR_BORRADO}', 'Se fue', 'se.fue', now() - interval '30 days', now() - interval '1 day'),
           ('${CREADOR_VIVO}',    '${WS_CREADOR_BORRADO}', 'Sigue',  'sigue',  now() - interval '10 days', NULL)
    ON CONFLICT DO NOTHING;
  `);
});

after(async () => {
  await t?.close();
});

/** Atajo: una transacción en el workspace de la creadora del seed. */
const enLaura = <T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> => t.db.withWorkspace(WORKSPACE_LAURA, fn);
const enSoloCsv = <T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> => t.db.withWorkspace(WS_SOLO_CSV, fn);

/** Hace `dias` días, en ISO: dentro de la ventana de 7 y de 30 sea cual sea el día en que corra la prueba. */
const haceDias = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();

const fila = (id: string, extra: Partial<CsvReading> = {}): CsvReading => ({
  externalPostId: id,
  publishedAt: haceDias(5),
  mediaType: 'video',
  title: `Video ${id}`,
  url: `https://www.instagram.com/reel/${id}/`,
  durationS: 31,
  views: 1000,
  reach: 900,
  likes: 80,
  comments: 4,
  shares: 9,
  saves: 22,
  followsFromPost: 3,
  reachNonFollowers: 600,
  ...extra,
});

/** Espera un CsvImportError con ese código: el texto lo pone la pantalla, no la base. */
const conCodigo = (code: CsvImportErrorCode) => (err: unknown) => {
  assert.ok(err instanceof CsvImportError, `se esperaba CsvImportError y llegó ${String(err)}`);
  assert.equal(err.code, code);
  return true;
};

describe('Resumen · los cuatro KPIs', () => {
  test('con el seed da las cifras del mock y compara contra el periodo anterior', async () => {
    const kpis = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));

    // El mock: 412 000 seguidores en cuatro redes.
    assert.equal(kpis.followers.value, 412_000);
    assert.ok(kpis.followers.previous !== null && kpis.followers.previous < 412_000);
    assert.ok(kpis.followers.delta !== null && kpis.followers.delta > 0);
    // Doce puntos, del periodo anterior al actual, y los extremos cuadran con el KPI.
    assert.equal(kpis.followers.spark.length, 12);
    assert.equal(kpis.followers.spark.at(-1), kpis.followers.value);
    assert.equal(kpis.followers.spark[0], kpis.followers.previous);
    // La variación llega hecha de Postgres y cuadra con el valor y el anterior.
    assert.ok(Math.abs(kpis.followers.delta! - (kpis.followers.value! / kpis.followers.previous! - 1)) < 1e-9);
    assert.ok(kpis.savesPer1k.delta === null || Number.isFinite(kpis.savesPer1k.delta));

    // El mock: ~2,6 M de visualizaciones en treinta días, de la cuenta.
    assert.ok(kpis.views.value! > 2_000_000 && kpis.views.value! < 3_500_000);
    assert.equal(kpis.viewsSource, 'account');
    assert.equal(kpis.hasAccountSeries, true);

    // Razones, no porcentajes ya formateados, y la base sobre la que se calcularon.
    assert.ok(kpis.nonFollowerReach.value! > 0.4 && kpis.nonFollowerReach.value! < 0.8);
    assert.ok(kpis.savesPer1k.value! > 5 && kpis.savesPer1k.value! < 40);
    assert.ok(kpis.posts > 0);
    assert.ok(kpis.nonFollowerReach.sample! > 0 && kpis.nonFollowerReach.sample! <= kpis.posts);
    assert.ok(kpis.savesPer1k.sample! > 0 && kpis.savesPer1k.sample! <= kpis.posts);

    // La ventana es la que dice el periodo.
    assert.match(kpis.end!, /^\d{4}-\d{2}-\d{2}$/);
    const dias = (Date.parse(kpis.end!) - Date.parse(kpis.start!)) / 86_400_000;
    assert.equal(dias, 29);
  });

  test('el filtro por red deja solo esa red', async () => {
    const todas = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));
    const tiktok = await enLaura((tx) => getResumenKpis(tx, { days: 30, platform: 'tiktok' }));
    assert.equal(tiktok.followers.value, 214_000); // FOLLOWERS_NOW del mock
    assert.ok(tiktok.followers.value! < todas.followers.value!);
    assert.ok(tiktok.views.value! < todas.views.value!);
    assert.ok(tiktok.posts < todas.posts);
  });

  test('el periodo cambia la ventana, no el último día', async () => {
    const siete = await enLaura((tx) => getResumenKpis(tx, { days: 7 }));
    const noventa = await enLaura((tx) => getResumenKpis(tx, { days: 90 }));
    assert.equal(siete.end, noventa.end);
    assert.ok(Date.parse(noventa.start!) < Date.parse(siete.start!));
    // Los seguidores son un valor de un instante: no dependen de la ventana.
    assert.equal(siete.followers.value, noventa.followers.value);
    // Las visualizaciones son una suma: noventa días acumulan más que siete.
    assert.ok(noventa.views.value! > siete.views.value!);
  });

  test('una ventana que la historia no cubre sale NULL, no cero', async () => {
    // El seed tiene noventa días de serie de cuenta. Con periodo de 90,
    // la ventana anterior cae fuera: la comparación no existe y la
    // sparkline de las SUMAS se queda con el tramo que sí hay.
    const noventa = await enLaura((tx) => getResumenKpis(tx, { days: 90 }));
    assert.ok(noventa.views.value !== null, 'el periodo actual sí está cubierto');
    assert.equal(noventa.views.previous, null);
    assert.equal(noventa.views.delta, null);
    assert.ok(noventa.views.spark.length < 12);
    // Los seguidores son un valor de un instante, no una suma: ahí sí
    // hay lectura anterior y la comparación existe.
    assert.ok(noventa.followers.value !== null);
    // Ningún hueco dentro de la sparkline: siempre es el tramo final.
    for (const s of [noventa.views.spark, noventa.savesPer1k.spark]) {
      assert.ok(s.every((v) => typeof v === 'number' && Number.isFinite(v)));
    }
  });

  test('un workspace sin lecturas devuelve NULL, no cero', async () => {
    const kpis = await t.db.withWorkspace(WS_VECINO, (tx) => getResumenKpis(tx, { days: 30 }));
    assert.equal(kpis.end, null);
    assert.equal(kpis.followers.value, null);
    assert.equal(kpis.views.value, null);
    assert.equal(kpis.viewsSource, null);
    assert.equal(kpis.followers.delta, null);
    assert.deepEqual(kpis.followers.spark, []);
    assert.equal(kpis.posts, 0);
  });

  test('un periodo o una red que no existen se rechazan antes de consultar', async () => {
    await assert.rejects(
      () => enLaura((tx) => getResumenKpis(tx, { days: 45 as never })),
      /periodo inválido/,
    );
    await assert.rejects(
      () => enLaura((tx) => getResumenKpis(tx, { days: 30, platform: 'twitter' as never })),
      /red inválida/,
    );
  });
});

describe('Resumen · las dos series', () => {
  test('seguidores por red: un punto por día y la curva nunca baja', async () => {
    const serie = await enLaura((tx) => getFollowersByPlatform(tx, { days: 90 }));
    assert.equal(serie.labels.length, 90);
    assert.equal(serie.series.length, 4);
    assert.equal(serie.hasAccountSeries, true);
    for (const s of serie.series) {
      assert.equal(s.data.length, serie.labels.length, `la serie de ${s.platformId} no cuadra con las etiquetas`);
      for (let i = 1; i < s.data.length; i++) {
        assert.ok(s.data[i]! >= s.data[i - 1]!, `${s.platformId} baja en el día ${serie.labels[i]}`);
      }
    }
    const tiktok = serie.series.find((s) => s.platformId === 'tiktok');
    assert.equal(tiktok?.data.at(-1), 214_000);
  });

  test('visualizaciones por bloque: el paso lo marca el periodo y el último bloque está completo', async () => {
    assert.equal(bucketStep(7), 1);
    assert.equal(bucketStep(30), 5);
    assert.equal(bucketStep(90), 10);

    const mes = await enLaura((tx) => getViewsByBucket(tx, { days: 30 }));
    assert.equal(mes.step, 5);
    assert.equal(mes.source, 'account');
    assert.equal(mes.buckets.length, 6);

    const trimestre = await enLaura((tx) => getViewsByBucket(tx, { days: 90 }));
    assert.equal(trimestre.step, 10);
    assert.equal(trimestre.buckets.length, 9);
    for (const b of trimestre.buckets) {
      assert.equal((Date.parse(b.end) - Date.parse(b.start)) / 86_400_000, 9);
    }
    // Ordenados de más viejo a más nuevo.
    assert.ok(Date.parse(trimestre.buckets[0]!.start) < Date.parse(trimestre.buckets.at(-1)!.start));

    const dias = await enLaura((tx) => getViewsByBucket(tx, { days: 7 }));
    assert.equal(dias.step, 1);
    assert.equal(dias.buckets.length, 7);
    assert.equal(dias.series.every((s) => s.data.length === 7), true);
  });

  test('con cualquier periodo, la última barra cae en la rejilla de etiquetas del kit', async () => {
    // BarChart etiqueta cada ceil(n/8) categorías y ADEMÁS fuerza la
    // última: si esa no cae en la rejilla, sus dos etiquetas se pisan.
    for (const days of [7, 30, 90] as const) {
      const serie = await enLaura((tx) => getViewsByBucket(tx, { days }));
      assert.ok(
        lastLabelOnGrid(serie.buckets.length),
        `con ${days} días salen ${serie.buckets.length} barras y la última etiqueta se pisa con la anterior`,
      );
    }
  });

  test('las barras cubren exactamente el periodo: el gráfico y la tarjeta cuentan los mismos días', async () => {
    for (const days of [7, 30, 90] as const) {
      assert.equal(days % bucketStep(days), 0, `${days} días no se reparten en barras de ${bucketStep(days)}`);
      const serie = await enLaura((tx) => getViewsByBucket(tx, { days }));
      const kpis = await enLaura((tx) => getResumenKpis(tx, { days }));
      assert.equal(serie.buckets[0]!.start, kpis.start, `con ${days} días el gráfico empieza otro día que la tarjeta`);
      assert.equal(serie.buckets.at(-1)!.end, kpis.end);
      // Y suman lo mismo: el total de las barras ES la cifra de la tarjeta.
      const total = serie.series.flatMap((x) => x.data).reduce((a, b) => a + b, 0);
      assert.equal(total, kpis.views.value, `con ${days} días las barras y la tarjeta no cuadran`);
    }
  });

  test('una conexión nueva no recorta la serie de las que llevan meses midiendo', async () => {
    const antes = await enLaura((tx) => getFollowersByPlatform(tx, { days: 90 }));
    assert.equal(antes.labels.length, 90);

    // Una quinta cuenta con UNA sola lectura, la del último día.
    const nueva = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'recien.llegada' }));
    try {
      await enLaura((tx) =>
        tx.query(
          `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, views)
           SELECT $1, current_workspace_id(), max(a.day), 1200, 300 FROM account_metric_snapshot a`,
          [nueva.connectionId],
        ),
      );

      const despues = await enLaura((tx) => getFollowersByPlatform(tx, { days: 90 }));
      assert.equal(despues.labels.length, 90, 'la conexión joven recortó la ventana de todas');
      const bloques = await enLaura((tx) => getViewsByBucket(tx, { days: 90 }));
      assert.equal(bloques.buckets.length, 9, 'la conexión joven vació el gráfico de barras');
      // Y su red sigue sumando lo de siempre en el último punto, más la nueva.
      const tiktokAntes = antes.series.find((x) => x.platformId === 'tiktok')!.data.at(-1)!;
      const tiktokDespues = despues.series.find((x) => x.platformId === 'tiktok')!.data.at(-1)!;
      assert.equal(tiktokDespues, tiktokAntes + 1200);
    } finally {
      await t.admin(`DELETE FROM social_connection WHERE id = '${nueva.connectionId}'`);
    }
  });

  test('el filtro por red también recorta las series', async () => {
    const solo = await enLaura((tx) => getFollowersByPlatform(tx, { days: 30, platform: 'youtube' }));
    assert.deepEqual(solo.series.map((s) => s.platformId), ['youtube']);
  });
});

describe('Resumen · frescura y cobertura', () => {
  test('cada conexión dice hasta cuándo llegan sus datos y de dónde vinieron', async () => {
    const filas = await enLaura((tx) => getFreshnessByConnection(tx));
    assert.equal(filas.length, 4);
    for (const f of filas) {
      assert.match(f.lastAccountDay!, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(f.lastSyncedReadingDay!, /^\d{4}-\d{2}-\d{2}$/, 'el seed trae lecturas de la API');
      assert.equal(f.lastCsvDay, null);
      assert.match(f.dataUntil!, /^\d{4}-\d{2}-\d{2}$/);
      // Todas al día con el reloj del módulo, o casi.
      assert.ok(f.daysBehind !== null && f.daysBehind >= 0 && f.daysBehind <= 2, `daysBehind = ${f.daysBehind}`);
      assert.equal(f.status, 'active');
      assert.ok(f.lastSyncedAt);
    }
    // El seed deja el token de YouTube a punto de vencer: connection_health lo marca.
    assert.equal(filas.find((f) => f.platformId === 'youtube')?.tokenExpiringSoon, true);
  });

  test('el filtro por red también se aplica a la frescura', async () => {
    const tiktok = await enLaura((tx) => getFreshnessByConnection(tx, { platform: 'tiktok' }));
    assert.ok(tiktok.length > 0);
    assert.ok(tiktok.every((f) => f.platformId === 'tiktok'));
    await assert.rejects(() => enLaura((tx) => getFreshnessByConnection(tx, { platform: 'myspace' as never })), /red inválida/);
  });

  test('la cobertura distingue "sin conexiones" de "sin datos"', async () => {
    const laura = await enLaura((tx) => getResumenCoverage(tx));
    assert.equal(laura.connections, 4);
    assert.equal(laura.withData, 4);
    // El conteo de posts va aparte: no entra en el camino crítico de la pantalla.
    assert.ok((await enLaura((tx) => countPosts(tx))) >= 60);

    const vecino = await t.db.withWorkspace(WS_VECINO, (tx) => getResumenCoverage(tx));
    assert.deepEqual(vecino, { connections: 0, withData: 0 });
    assert.equal(await t.db.withWorkspace(WS_VECINO, (tx) => countPosts(tx)), 0);
  });
});

describe('Resumen · un workspace que SOLO importó CSV', () => {
  // El caso para el que existe RES-2: ni una fila de serie de cuenta,
  // solo post + post_metric_snapshot. Si el reloj del módulo mirase
  // únicamente account_metric_snapshot, aquí todo saldría null y la
  // pantalla enseñaría cuatro «—» y dos gráficos vacíos.
  before(async () => {
    const cuenta = await enSoloCsv((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: 'solo.csv' }));
    await enSoloCsv((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'instagram',
        rows: [fila('csv_1'), fila('csv_2', { publishedAt: haceDias(3), views: 3000, saves: 30 })],
      }),
    );
  });

  test('los cuatro KPIs: los de contenido con cifra, las visualizaciones de lo publicado', async () => {
    const cobertura = await enSoloCsv((tx) => getResumenCoverage(tx));
    assert.deepEqual(cobertura, { connections: 1, withData: 1 });

    const kpis = await enSoloCsv((tx) => getResumenKpis(tx, { days: 30 }));
    assert.ok(kpis.end !== null, 'el módulo tiene "hoy" aunque no haya serie de cuenta');
    assert.equal(kpis.posts, 2);
    assert.equal(kpis.hasAccountSeries, false);
    // (600 + 600) / (900 + 900)
    assert.ok(Math.abs(kpis.nonFollowerReach.value! - 1200 / 1800) < 1e-9);
    assert.equal(kpis.nonFollowerReach.sample, 2);
    // (22 + 30) * 1000 / (1000 + 3000)
    assert.ok(Math.abs(kpis.savesPer1k.value! - 13) < 1e-9);
    // Sin serie de cuenta, las visualizaciones son las de lo publicado, y se dice.
    assert.equal(kpis.views.value, 4000);
    assert.equal(kpis.viewsSource, 'content');
    // Lo que de verdad no se sabe sigue siendo null, no cero.
    assert.equal(kpis.followers.value, null);
  });

  test('el gráfico de visualizaciones se llena por fecha de publicación; el de seguidores explica por qué no', async () => {
    const views = await enSoloCsv((tx) => getViewsByBucket(tx, { days: 30 }));
    assert.equal(views.source, 'content');
    assert.ok(views.buckets.length > 0, 'el gráfico de visualizaciones no puede salir vacío');
    const total = views.series.flatMap((s) => s.data).reduce((a, b) => a + b, 0);
    assert.equal(total, 4000);
    assert.deepEqual(views.series.map((s) => s.platformId), ['instagram']);

    const seguidores = await enSoloCsv((tx) => getFollowersByPlatform(tx, { days: 30 }));
    assert.deepEqual(seguidores.labels, []);
    assert.equal(seguidores.hasAccountSeries, false, 'la pantalla necesita saber que falta la cuenta, no el periodo');
  });

  test('la frescura de una cuenta CSV tiene fecha: no dice «sin lecturas»', async () => {
    const frescura = await enSoloCsv((tx) => getFreshnessByConnection(tx));
    assert.equal(frescura.length, 1);
    assert.equal(frescura[0]!.lastAccountDay, null);
    assert.equal(frescura[0]!.lastSyncedReadingDay, null);
    assert.match(frescura[0]!.lastCsvDay!, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(frescura[0]!.dataUntil!, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Resumen · importación por CSV', () => {
  test('crea la cuenta importada una sola vez y la reutiliza', async () => {
    const primera = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: '@taller.csv' }));
    const segunda = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: 'Taller.csv' }));
    assert.equal(primera.connectionId, segunda.connectionId);
    assert.equal(primera.handle, 'taller.csv'); // sin la arroba
    assert.equal(primera.accessMode, 'manual_csv');

    const cuentas = await enLaura((tx) => listImportableAccounts(tx, 'instagram'));
    assert.ok(cuentas.some((c) => c.connectionId === primera.connectionId));
    // La de OAuth del seed sigue estando: el creador elige a cuál pega el archivo.
    assert.ok(cuentas.some((c) => c.accessMode === 'direct_oauth'));
  });

  test('una cuenta importada que el creador borró no resucita con su historial', async () => {
    const vieja = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'borrada' }));
    await enLaura((tx) => importCsvReadings(tx, { connectionId: vieja.connectionId, platform: 'tiktok', rows: [fila('del_1')] }));
    await t.admin(`UPDATE social_connection SET deleted_at = now() WHERE id = '${vieja.connectionId}'`);

    const nueva = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'borrada' }));
    assert.notEqual(nueva.connectionId, vieja.connectionId);
    assert.equal(nueva.posts, 0, 'la cuenta nueva no hereda los videos de la borrada');
    assert.equal(nueva.handle, 'borrada');
    const [estado] = await enLaura((tx) =>
      tx.query<{ viva: boolean }>('SELECT deleted_at IS NULL AS viva FROM social_connection WHERE id = $1', [vieja.connectionId])
        .then((r) => r.rows),
    );
    assert.equal(estado?.viva, false, 'la borrada sigue borrada');
    // Y la tercera vez reutiliza la nueva, no crea otra.
    const otraVez = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'borrada' }));
    assert.equal(otraVez.connectionId, nueva.connectionId);
  });

  test('la cuenta importada nunca se cuelga de un creador borrado', async () => {
    const cuenta = await t.db.withWorkspace(WS_CREADOR_BORRADO, (tx) =>
      ensureCsvConnection(tx, { platform: 'youtube', handle: 'con.creador' }),
    );
    const [fila0] = await t.db.withWorkspace(WS_CREADOR_BORRADO, (tx) =>
      tx.query<{ creator_id: string }>('SELECT creator_id FROM social_connection WHERE id = $1', [cuenta.connectionId])
        .then((r) => r.rows),
    );
    assert.equal(fila0?.creator_id, CREADOR_VIVO);
  });

  test('escribe post y lectura con source csv_import y age_hours de la base', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'importada' }));
    const r = await enLaura((tx) =>
      importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'tiktok', rows: [fila('tt_1'), fila('tt_2')] }),
    );
    assert.deepEqual({ newPosts: r.newPosts, knownPosts: r.knownPosts, readings: r.readings }, {
      newPosts: 2, knownPosts: 0, readings: 2,
    });

    const filas = await enLaura((tx) =>
      tx.query<{ source: string; age_hours: string; total_interactions: string; reach_followers: string }>(
        `SELECT s.source, s.age_hours, s.total_interactions, s.reach_followers
           FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
          WHERE p.connection_id = $1 ORDER BY p.external_post_id`,
        [cuenta.connectionId],
      ).then((r2) => r2.rows),
    );
    assert.equal(filas.length, 2);
    assert.equal(filas[0]!.source, 'csv_import');
    // age_hours la calcula Postgres a partir de published_at: unos cinco días.
    assert.ok(Number(filas[0]!.age_hours) > 5 * 24 - 1 && Number(filas[0]!.age_hours) < 5 * 24 + 1);
    // total_interactions e interacciones de seguidores salen derivadas, no del archivo.
    assert.equal(Number(filas[0]!.total_interactions), 80 + 4 + 9 + 22);
    assert.equal(Number(filas[0]!.reach_followers), 900 - 600);
  });

  test('el mismo archivo dos veces añade lecturas y no duplica el video', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'youtube', handle: 'dos.veces' }));
    await enLaura((tx) => importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'youtube', rows: [fila('yt_1')] }));
    const segunda = await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'youtube',
        rows: [fila('yt_1', { views: 1500 }), fila('yt_2')],
      }),
    );
    // Los nuevos salen de lo que devolvió el INSERT, no de restar conjuntos.
    assert.equal(segunda.newPosts, 1);
    assert.equal(segunda.knownPosts, 1);
    assert.equal(segunda.readings, 2);

    const [conteo] = await enLaura((tx) =>
      tx.query<{ posts: number; lecturas: number }>(
        `SELECT (SELECT count(*)::int FROM post WHERE connection_id = $1) AS posts,
                (SELECT count(*)::int FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
                  WHERE p.connection_id = $1) AS lecturas`,
        [cuenta.connectionId],
      ).then((r) => r.rows),
    );
    assert.deepEqual(conteo, { posts: 2, lecturas: 3 });

    // Y la «última lectura» es la segunda, sin empate: las dos
    // importaciones caen en el mismo segundo, pero no en el mismo microsegundo.
    const [ultima] = await enLaura((tx) =>
      tx.query<{ views: string }>(
        `SELECT m.views FROM post_metrics_latest m JOIN post p ON p.id = m.post_id
          WHERE p.connection_id = $1 AND p.external_post_id = 'yt_1'`,
        [cuenta.connectionId],
      ).then((r) => r.rows),
    );
    assert.equal(Number(ultima?.views), 1500);
  });

  test('un lote con el mismo video dos veces se rechaza entero y no escribe nada', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: 'repetidos' }));
    await assert.rejects(
      () =>
        enLaura((tx) =>
          importCsvReadings(tx, {
            connectionId: cuenta.connectionId,
            platform: 'instagram',
            rows: [fila('rep_1'), fila('rep_2'), fila('rep_1', { views: 5 })],
          }),
        ),
      conCodigo('duplicate_ids'),
    );
    assert.deepEqual(await enLaura((tx) => listExternalPostIds(tx, cuenta.connectionId, ['rep_1', 'rep_2'])), []);
  });

  test('un id de cuenta que no es un UUID se rechaza antes de llegar a Postgres', async () => {
    await assert.rejects(
      () => enLaura((tx) => importCsvReadings(tx, { connectionId: 'no-soy-uuid', platform: 'tiktok', rows: [fila('x')] })),
      conCodigo('invalid_connection'),
    );
    await assert.rejects(
      () => enLaura((tx) => listExternalPostIds(tx, "1' OR '1'='1", ['x'])),
      conCodigo('invalid_connection'),
    );
  });

  test('importar una vez mueve los KPIs de contenido y no mueve el reloj', async () => {
    const antes = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'facebook', handle: 'aparece' }));
    await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'facebook',
        // Un guardado por mil muy distinto del del seed: si entra, se nota.
        rows: [fila('fb_1', { views: 100_000, saves: 9_000 }), fila('fb_2', { views: 100_000, saves: 9_000 })],
      }),
    );
    const despues = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));

    assert.equal(despues.posts, antes.posts + 2);
    assert.equal(despues.savesPer1k.sample, antes.savesPer1k.sample! + 2);
    assert.ok(despues.savesPer1k.value! > antes.savesPer1k.value!, 'los guardados del CSV no llegaron al KPI');
    // Una lectura tomada hoy describe hasta ayer: el último día cerrado no se mueve.
    assert.equal(despues.end, antes.end);
    // Las visualizaciones siguen siendo las de la cuenta: el CSV no las toca.
    assert.equal(despues.views.value, antes.views.value);

    const frescura = await enLaura((tx) => getFreshnessByConnection(tx, { platform: 'facebook' }));
    const importada = frescura.find((f) => f.connectionId === cuenta.connectionId);
    assert.ok(importada?.lastCsvDay);
    assert.ok(importada?.dataUntil);
  });

  test('un video sin uno de los dos términos no diluye la razón', async () => {
    // El CSV de Instagram no trae alcance en no seguidores y el de
    // YouTube no trae guardados. Sumar sus denominadores bajaba los dos
    // KPIs sin que pasara nada real.
    const antes = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: 'sin.terminos' }));
    await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'instagram',
        rows: [
          fila('inc_1', { reachNonFollowers: null, saves: null, views: 50_000, reach: 40_000 }),
          fila('inc_2', { reachNonFollowers: null, saves: null, views: 80_000, reach: 70_000 }),
        ],
      }),
    );
    const despues = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));
    assert.equal(despues.posts, antes.posts + 2, 'los dos videos sí son del periodo');
    assert.equal(despues.nonFollowerReach.value, antes.nonFollowerReach.value);
    assert.equal(despues.nonFollowerReach.sample, antes.nonFollowerReach.sample);
    assert.equal(despues.savesPer1k.value, antes.savesPer1k.value);
    assert.equal(despues.savesPer1k.sample, antes.savesPer1k.sample);
  });

  test('un CSV sobre una conexión OAuth no la da por sincronizada', async () => {
    // Si el recolector de esta cuenta estaba caído, moverle
    // last_synced_at lo taparía en connection_health y en Conexiones.
    const oauth = (await enLaura((tx) => listImportableAccounts(tx, 'instagram'))).find((c) => c.accessMode === 'direct_oauth')!;
    const leer = () =>
      enLaura((tx) =>
        tx.query<{ last_synced_at: string }>(
          `SELECT to_char(last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS last_synced_at
             FROM social_connection WHERE id = $1`,
          [oauth.connectionId],
        ).then((r) => r.rows[0]!.last_synced_at),
      );
    const antes = await leer();
    const frescuraAntes = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === oauth.connectionId)!;

    await enLaura((tx) =>
      importCsvReadings(tx, { connectionId: oauth.connectionId, platform: 'instagram', rows: [fila('oauth_csv_1')] }),
    );

    assert.equal(await leer(), antes);
    const frescura = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === oauth.connectionId)!;
    // Las dos fuentes, por separado: la de la API no cambió; la del CSV aparece.
    assert.equal(frescura.lastSyncedAt, frescuraAntes.lastSyncedAt);
    assert.equal(frescura.lastSyncedReadingDay, frescuraAntes.lastSyncedReadingDay);
    assert.equal(frescura.lastAccountDay, frescuraAntes.lastAccountDay);
    assert.equal(frescuraAntes.lastCsvDay, null);
    assert.ok(frescura.lastCsvDay);
  });

  test('una cuenta importada sí queda sincronizada al momento del archivo', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'youtube', handle: 'sincronizada' }));
    const r = await enLaura((tx) =>
      importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'youtube', rows: [fila('sync_1')] }),
    );
    const frescura = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === cuenta.connectionId)!;
    // La frescura sale al segundo; la captura, al microsegundo.
    assert.equal(frescura.lastSyncedAt, `${r.capturedAt.slice(0, 19)}Z`);
  });

  test('la previsualización puede preguntar qué ids ya existen, sin traerse la tabla', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: 'conocidos' }));
    await enLaura((tx) =>
      importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'instagram', rows: [fila('ig_ya_1'), fila('ig_ya_2')] }),
    );
    const hay = await enLaura((tx) => listExternalPostIds(tx, cuenta.connectionId, ['ig_ya_2', 'ig_nuevo']));
    assert.deepEqual(hay, ['ig_ya_2']);
    // Sin ids que preguntar, ni siquiera se consulta.
    assert.deepEqual(await enLaura((tx) => listExternalPostIds(tx, cuenta.connectionId, [])), []);
  });

  test('la lectura lleva la fecha de la exportación: age_hours y la cuenta la usan, no el reloj de la importación', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'instagram', handle: 'exportado.antes' }));
    const exportado = haceDias(4);
    const r = await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'instagram',
        rows: [fila('exp_1', { publishedAt: haceDias(10) })],
        capturedAt: exportado,
      }),
    );
    assert.equal(r.readings, 1);
    assert.equal(r.staleReadings, 0);
    assert.equal(Date.parse(r.capturedAt), Date.parse(exportado));
    const [lectura] = await enLaura((tx) =>
      tx.query<{ age_hours: string; captured_at: string }>(
        `SELECT s.age_hours, to_char(s.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at
           FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id WHERE p.connection_id = $1`,
        [cuenta.connectionId],
      ).then((x) => x.rows),
    );
    // Seis días entre publicar y exportar, no diez.
    assert.ok(Math.abs(Number(lectura!.age_hours) - 6 * 24) < 0.1, `age_hours = ${lectura!.age_hours}`);
    assert.equal(lectura!.captured_at, exportado);
    // Y la cuenta importada queda sincronizada a esa fecha, no a la de hoy.
    const frescura = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === cuenta.connectionId)!;
    assert.equal(Date.parse(frescura.lastSyncedAt!), Math.floor(Date.parse(exportado) / 1000) * 1000);
  });

  test('un archivo exportado ANTES que la última lectura no cambia la última ni mueve el reloj', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'orden.de.llegada' }));
    // Primero el archivo nuevo, exportado hace un día…
    await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'tiktok',
        rows: [fila('ord_1', { publishedAt: haceDias(20), views: 9_000 })],
        capturedAt: haceDias(1),
      }),
    );
    const ultima = () =>
      enLaura((tx) =>
        tx.query<{ views: string; captured_at: string }>(
          `SELECT m.views, m.captured_at::text AS captured_at FROM post_metrics_latest m JOIN post p ON p.id = m.post_id
            WHERE p.connection_id = $1 AND p.external_post_id = 'ord_1'`,
          [cuenta.connectionId],
        ).then((x) => x.rows[0]!),
      );
    const antes = await ultima();
    const kpisAntes = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));
    const frescuraAntes = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === cuenta.connectionId)!;

    // …y después uno viejo, exportado hace doce días, con cifras menores.
    const r = await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'tiktok',
        rows: [fila('ord_1', { publishedAt: haceDias(20), views: 2_000 }), fila('ord_2', { publishedAt: haceDias(15) })],
        capturedAt: haceDias(12),
      }),
    );
    // El video conocido NO recibe la lectura vieja; el nuevo sí entra.
    assert.deepEqual(
      { newPosts: r.newPosts, knownPosts: r.knownPosts, readings: r.readings, staleReadings: r.staleReadings },
      { newPosts: 1, knownPosts: 1, readings: 1, staleReadings: 1 },
    );
    assert.deepEqual(await ultima(), antes, 'la lectura vieja pasó a ser la «última»');
    const kpisDespues = await enLaura((tx) => getResumenKpis(tx, { days: 30 }));
    assert.equal(kpisDespues.end, kpisAntes.end, 'un archivo viejo movió el reloj del módulo');
    const frescura = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === cuenta.connectionId)!;
    assert.equal(frescura.lastCsvDay, frescuraAntes.lastCsvDay);
    assert.equal(frescura.lastSyncedAt, frescuraAntes.lastSyncedAt, 'last_synced_at no puede ir hacia atrás');
  });

  test('una fecha de exportación imposible se rechaza: del futuro, o anterior a un video del archivo', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'fechas.imposibles' }));
    const importar = (capturedAt: string) =>
      enLaura((tx) =>
        importCsvReadings(tx, {
          connectionId: cuenta.connectionId,
          platform: 'tiktok',
          rows: [fila('imp_1', { publishedAt: haceDias(3) })],
          capturedAt,
        }),
      );
    await assert.rejects(() => importar(new Date(Date.now() + 86_400_000).toISOString()), conCodigo('invalid_captured_at'));
    await assert.rejects(() => importar(haceDias(5)), conCodigo('invalid_captured_at'));
    await assert.rejects(() => importar('el martes'), conCodigo('invalid_captured_at'));
    assert.deepEqual(await enLaura((tx) => listExternalPostIds(tx, cuenta.connectionId, ['imp_1'])), []);
  });

  test('la frescura dice el DÍA CERRADO con la regla del reloj, no el instante en UTC', async () => {
    // Una importación a las 21:55 en Bogotá son las 02:55 UTC del día
    // siguiente. Con el instante formateado en UTC salía un día en el
    // futuro para el creador; con la regla del reloj sale el día anterior
    // al de la lectura en UTC, igual que el resto de la página.
    const cuenta = await t.db.withWorkspace(WS_VECINO, (tx) => ensureCsvConnection(tx, { platform: 'youtube', handle: 'madrugada' }));
    try {
      const dia = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
      await t.db.withWorkspace(WS_VECINO, (tx) =>
        importCsvReadings(tx, {
          connectionId: cuenta.connectionId,
          platform: 'youtube',
          rows: [fila('mad_1', { publishedAt: haceDias(9) })],
          capturedAt: `${dia}T02:00:00.000Z`,
        }),
      );
      const [frescura] = await t.db.withWorkspace(WS_VECINO, (tx) => getFreshnessByConnection(tx));
      const anterior = new Date(Date.parse(`${dia}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      assert.equal(frescura!.lastCsvDay, anterior);
      assert.equal(frescura!.dataUntil, anterior);
      // Es la única conexión del vecino, así que es la que marca su reloj: al día.
      assert.equal(frescura!.daysBehind, 0);
      const kpis = await t.db.withWorkspace(WS_VECINO, (tx) => getResumenKpis(tx, { days: 30 }));
      assert.equal(kpis.end, anterior, 'la frescura y el reloj del módulo dicen días distintos');
    } finally {
      await t.admin(`DELETE FROM social_connection WHERE id = '${cuenta.connectionId}'`);
    }
  });

  test('una conexión que se quedó atrás lo dice en días, y su estado viaja', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'facebook', handle: 'rezagada' }));
    await enLaura((tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: 'facebook',
        rows: [fila('rez_1', { publishedAt: haceDias(40) })],
        capturedAt: haceDias(20),
      }),
    );
    await t.admin(`UPDATE social_connection SET status = 'error' WHERE id = '${cuenta.connectionId}'`);
    const frescura = (await enLaura((tx) => getFreshnessByConnection(tx))).find((f) => f.connectionId === cuenta.connectionId)!;
    assert.ok(frescura.daysBehind! >= 18, `daysBehind = ${frescura.daysBehind}`);
    assert.equal(frescura.status, 'error');
  });

  test('un lote vacío o una cuenta de otro workspace se rechazan', async () => {
    const cuenta = await enLaura((tx) => ensureCsvConnection(tx, { platform: 'tiktok', handle: 'rechazos' }));
    await assert.rejects(
      () => enLaura((tx) => importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'tiktok', rows: [] })),
      conCodigo('empty_batch'),
    );
    // La misma conexión, pero desde el workspace vecino —que SÍ tiene
    // creador—: RLS no la ve, y el motivo tiene que ser ese y no otro.
    await assert.rejects(
      () =>
        t.db.withWorkspace(WS_VECINO, (tx) =>
          importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'tiktok', rows: [fila('x')] }),
        ),
      conCodigo('connection_not_found'),
    );
    // Y el vecino tampoco puede preguntar qué videos tiene la cuenta ajena.
    await enLaura((tx) => importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: 'tiktok', rows: [fila('ajeno_1')] }));
    assert.deepEqual(
      await t.db.withWorkspace(WS_VECINO, (tx) => listExternalPostIds(tx, cuenta.connectionId, ['ajeno_1'])),
      [],
    );
  });
});
