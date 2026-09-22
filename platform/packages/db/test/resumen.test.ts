/**
 * Las consultas del módulo Resumen (RES-1) y la escritura de la
 * importación por CSV (RES-2), contra el Postgres embebido con el seed
 * y sin red, como mc_app.
 *
 * Lo que se prueba aquí y no en la pantalla: que los números salgan de
 * SQL y no de React, que el filtro por red y el periodo cambien lo que
 * tienen que cambiar, que un workspace sin datos devuelva NULL —y no
 * ceros—, y que importar dos veces el mismo archivo añada lecturas sin
 * duplicar el video.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import {
  asegurarCuentaCsv,
  getCoberturaResumen,
  getFrescuraPorConexion,
  getResumenKpis,
  getSeguidoresPorRed,
  getViewsPorBloque,
  importarLecturasCsv,
  listCuentasImportables,
  pasoDeBloque,
  type LecturaCsv,
} from '../src/queries/resumen.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Un workspace vecino, vacío: el estado "sin datos" tiene que ser NULL, no cero. */
const WS_VECINO = '0000000c-0000-4000-8000-000000000042';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_VECINO}', 'vecino-resumen', 'Estudio vecino', 'COP', 'America/Bogota', 'es-CO', 'CO')
    ON CONFLICT DO NOTHING;
  `);
});

after(async () => {
  await t?.close();
});

/** Atajo: una transacción en el workspace de la creadora del seed. */
const enLaura = <T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> => t.db.withWorkspace(WORKSPACE_LAURA, fn);

describe('Resumen · los cuatro KPIs', () => {
  test('con el seed da las cifras del mock y compara contra el periodo anterior', async () => {
    const kpis = await enLaura((tx) => getResumenKpis(tx, { dias: 30 }));

    // El mock: 412 000 seguidores en cuatro redes.
    assert.equal(kpis.followers.value, 412_000);
    assert.ok(kpis.followers.previous !== null && kpis.followers.previous < 412_000);
    assert.ok(kpis.followers.delta !== null && kpis.followers.delta > 0);
    // Doce puntos, del periodo anterior al actual, y los extremos cuadran con el KPI.
    assert.equal(kpis.followers.spark.length, 12);
    assert.equal(kpis.followers.spark.at(-1), kpis.followers.value);
    assert.equal(kpis.followers.spark[0], kpis.followers.previous);

    // El mock: ~2,6 M de views en treinta días.
    assert.ok(kpis.views.value! > 2_000_000 && kpis.views.value! < 3_500_000);

    // Razones, no porcentajes ya formateados.
    assert.ok(kpis.nonFollowerReach.value! > 0.4 && kpis.nonFollowerReach.value! < 0.8);
    assert.ok(kpis.savesPer1k.value! > 5 && kpis.savesPer1k.value! < 40);
    assert.ok(kpis.posts > 0);

    // La ventana es la que dice el periodo.
    assert.match(kpis.hasta!, /^\d{4}-\d{2}-\d{2}$/);
    const dias = (Date.parse(kpis.hasta!) - Date.parse(kpis.desde!)) / 86_400_000;
    assert.equal(dias, 29);
  });

  test('el filtro por red deja solo esa red', async () => {
    const todas = await enLaura((tx) => getResumenKpis(tx, { dias: 30 }));
    const tiktok = await enLaura((tx) => getResumenKpis(tx, { dias: 30, red: 'tiktok' }));
    assert.equal(tiktok.followers.value, 214_000); // FOLLOWERS_NOW del mock
    assert.ok(tiktok.followers.value! < todas.followers.value!);
    assert.ok(tiktok.views.value! < todas.views.value!);
    assert.ok(tiktok.posts < todas.posts);
  });

  test('el periodo cambia la ventana, no el último día', async () => {
    const siete = await enLaura((tx) => getResumenKpis(tx, { dias: 7 }));
    const noventa = await enLaura((tx) => getResumenKpis(tx, { dias: 90 }));
    assert.equal(siete.hasta, noventa.hasta);
    assert.ok(Date.parse(noventa.desde!) < Date.parse(siete.desde!));
    // Los seguidores son un valor de un instante: no dependen de la ventana.
    assert.equal(siete.followers.value, noventa.followers.value);
    // Las views son una suma: noventa días acumulan más que siete.
    assert.ok(noventa.views.value! > siete.views.value!);
  });

  test('una ventana que la historia no cubre sale NULL, no cero', async () => {
    // El seed tiene noventa días de serie de cuenta. Con periodo de 90,
    // la ventana anterior cae fuera: la comparación no existe y la
    // sparkline de las SUMAS se queda con el tramo que sí hay.
    const noventa = await enLaura((tx) => getResumenKpis(tx, { dias: 90 }));
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
    const kpis = await t.db.withWorkspace(WS_VECINO, (tx) => getResumenKpis(tx, { dias: 30 }));
    assert.equal(kpis.hasta, null);
    assert.equal(kpis.followers.value, null);
    assert.equal(kpis.views.value, null);
    assert.equal(kpis.followers.delta, null);
    assert.deepEqual(kpis.followers.spark, []);
    assert.equal(kpis.posts, 0);
  });

  test('un periodo o una red que no existen se rechazan antes de consultar', async () => {
    await assert.rejects(
      () => enLaura((tx) => getResumenKpis(tx, { dias: 45 as never })),
      /periodo inválido/,
    );
    await assert.rejects(
      () => enLaura((tx) => getResumenKpis(tx, { dias: 30, red: 'twitter' as never })),
      /red inválida/,
    );
  });
});

describe('Resumen · las dos series', () => {
  test('seguidores por red: un punto por día y la curva nunca baja', async () => {
    const serie = await enLaura((tx) => getSeguidoresPorRed(tx, { dias: 90 }));
    assert.equal(serie.labels.length, 90);
    assert.equal(serie.series.length, 4);
    for (const s of serie.series) {
      assert.equal(s.data.length, serie.labels.length, `la serie de ${s.platformId} no cuadra con las etiquetas`);
      for (let i = 1; i < s.data.length; i++) {
        assert.ok(s.data[i]! >= s.data[i - 1]!, `${s.platformId} baja en el día ${serie.labels[i]}`);
      }
    }
    const tiktok = serie.series.find((s) => s.platformId === 'tiktok');
    assert.equal(tiktok?.data.at(-1), 214_000);
  });

  test('views por bloque: el paso lo marca el periodo y el último bloque está completo', async () => {
    assert.equal(pasoDeBloque(7), 1);
    assert.equal(pasoDeBloque(30), 2);
    assert.equal(pasoDeBloque(90), 7);

    const quincena = await enLaura((tx) => getViewsPorBloque(tx, { dias: 30 }));
    assert.equal(quincena.paso, 2);
    assert.equal(quincena.bloques.length, 15);

    const semanas = await enLaura((tx) => getViewsPorBloque(tx, { dias: 90 }));
    assert.equal(semanas.paso, 7);
    assert.equal(semanas.bloques.length, 12); // las doce semanas del mock
    for (const b of semanas.bloques) {
      assert.equal((Date.parse(b.fin) - Date.parse(b.inicio)) / 86_400_000, 6);
    }
    // Ordenados de más viejo a más nuevo.
    assert.ok(Date.parse(semanas.bloques[0]!.inicio) < Date.parse(semanas.bloques.at(-1)!.inicio));

    const dias = await enLaura((tx) => getViewsPorBloque(tx, { dias: 7 }));
    assert.equal(dias.paso, 1);
    assert.equal(dias.bloques.length, 7);
    assert.equal(dias.series.every((s) => s.data.length === 7), true);
  });

  test('el filtro por red también recorta las series', async () => {
    const solo = await enLaura((tx) => getSeguidoresPorRed(tx, { dias: 30, red: 'youtube' }));
    assert.deepEqual(solo.series.map((s) => s.platformId), ['youtube']);
  });
});

describe('Resumen · frescura y cobertura', () => {
  test('cada conexión dice hasta cuándo llegan sus datos y de dónde vinieron', async () => {
    const filas = await enLaura((tx) => getFrescuraPorConexion(tx));
    assert.equal(filas.length, 4);
    for (const f of filas) {
      assert.match(f.ultimoDiaCuenta!, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(f.ultimaFuente, 'api');
      assert.ok(f.lastSyncedAt);
    }
    // El seed deja el token de YouTube a punto de vencer: connection_health lo marca.
    assert.equal(filas.find((f) => f.platformId === 'youtube')?.tokenExpiringSoon, true);
  });

  test('la cobertura distingue "sin conexiones" de "sin datos"', async () => {
    const laura = await enLaura((tx) => getCoberturaResumen(tx));
    assert.equal(laura.conexiones, 4);
    assert.equal(laura.conDatos, 4);
    assert.ok(laura.posts >= 60);

    const vecino = await t.db.withWorkspace(WS_VECINO, (tx) => getCoberturaResumen(tx));
    assert.deepEqual(vecino, { conexiones: 0, conDatos: 0, posts: 0 });
  });
});

describe('Resumen · importación por CSV', () => {
  const fila = (id: string, extra: Partial<LecturaCsv> = {}): LecturaCsv => ({
    externalPostId: id,
    publishedAt: '2026-09-10T15:00:00Z',
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

  test('crea la cuenta importada una sola vez y la reutiliza', async () => {
    const primera = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'instagram', handle: '@taller.csv' }));
    const segunda = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'instagram', handle: 'taller.csv' }));
    assert.equal(primera.connectionId, segunda.connectionId);
    assert.equal(primera.handle, 'taller.csv'); // sin la arroba
    assert.equal(primera.accessMode, 'manual_csv');

    const cuentas = await enLaura((tx) => listCuentasImportables(tx, 'instagram'));
    assert.ok(cuentas.some((c) => c.connectionId === primera.connectionId));
    // La de OAuth del seed sigue estando: el creador elige a cuál pega el archivo.
    assert.ok(cuentas.some((c) => c.accessMode === 'direct_oauth'));
  });

  test('escribe post y lectura con source csv_import y age_hours de la base', async () => {
    const cuenta = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'tiktok', handle: 'importada' }));
    const r = await enLaura((tx) =>
      importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'tiktok', filas: [fila('tt_1'), fila('tt_2')] }),
    );
    assert.deepEqual({ postsNuevos: r.postsNuevos, postsConocidos: r.postsConocidos, lecturas: r.lecturas }, {
      postsNuevos: 2, postsConocidos: 0, lecturas: 2,
    });

    const filas = await enLaura((tx) =>
      tx.query<{ source: string; age_hours: string; views: string; total_interactions: string; reach_followers: string }>(
        `SELECT s.source, s.age_hours, s.views, s.total_interactions, s.reach_followers
           FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
          WHERE p.connection_id = $1 ORDER BY p.external_post_id`,
        [cuenta.connectionId],
      ).then((r2) => r2.rows),
    );
    assert.equal(filas.length, 2);
    assert.equal(filas[0]!.source, 'csv_import');
    // age_hours la calcula Postgres a partir de published_at: nunca el navegador.
    assert.ok(Number(filas[0]!.age_hours) > 0);
    // total_interactions e interacciones de seguidores salen derivadas, no del archivo.
    assert.equal(Number(filas[0]!.total_interactions), 80 + 4 + 9 + 22);
    assert.equal(Number(filas[0]!.reach_followers), 900 - 600);
  });

  test('el mismo archivo dos veces añade lecturas y no duplica el video', async () => {
    const cuenta = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'youtube', handle: 'dos.veces' }));
    await enLaura((tx) => importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'youtube', filas: [fila('yt_1')] }));
    const segunda = await enLaura((tx) =>
      importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'youtube', filas: [fila('yt_1', { views: 1500 })] }),
    );
    assert.equal(segunda.postsNuevos, 0);
    assert.equal(segunda.postsConocidos, 1);
    assert.equal(segunda.lecturas, 1);

    const [conteo] = await enLaura((tx) =>
      tx.query<{ posts: number; lecturas: number }>(
        `SELECT (SELECT count(*)::int FROM post WHERE connection_id = $1) AS posts,
                (SELECT count(*)::int FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
                  WHERE p.connection_id = $1) AS lecturas`,
        [cuenta.connectionId],
      ).then((r) => r.rows),
    );
    assert.deepEqual(conteo, { posts: 1, lecturas: 2 });
  });

  test('una importación aparece en el Resumen del workspace', async () => {
    const antes = await enLaura((tx) => getCoberturaResumen(tx));
    const cuenta = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'facebook', handle: 'aparece' }));
    await enLaura((tx) =>
      importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'facebook', filas: [fila('fb_1'), fila('fb_2')] }),
    );
    const despues = await enLaura((tx) => getCoberturaResumen(tx));
    assert.equal(despues.posts, antes.posts + 2);

    const frescura = await enLaura((tx) => getFrescuraPorConexion(tx));
    const importada = frescura.find((f) => f.connectionId === cuenta.connectionId);
    assert.equal(importada?.ultimaFuente, 'csv_import');
    assert.ok(importada?.ultimaLecturaContenido);
  });

  test('un lote vacío o una cuenta ajena se rechazan', async () => {
    const cuenta = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'tiktok', handle: 'rechazos' }));
    await assert.rejects(
      () => enLaura((tx) => importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'tiktok', filas: [] })),
      /No hay filas/,
    );
    // La misma conexión, pero desde el workspace vecino: RLS no la ve.
    await assert.rejects(
      () =>
        t.db.withWorkspace(WS_VECINO, (tx) =>
          importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'tiktok', filas: [fila('x')] }),
        ),
      /no existe en este workspace|no tiene ningún creador/,
    );
  });
});
