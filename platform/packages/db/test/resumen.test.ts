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
  contarPosts,
  getCoberturaResumen,
  getFrescuraPorConexion,
  getResumenKpis,
  getSeguidoresPorRed,
  getViewsPorBloque,
  importarLecturasCsv,
  listCuentasImportables,
  listExternalPostIds,
  pasoDeBloque,
  ultimaEtiquetaEnLaRejilla,
  type LecturaCsv,
} from '../src/queries/resumen.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

/** Un workspace vecino, vacío: el estado "sin datos" tiene que ser NULL, no cero. */
const WS_VECINO = '0000000c-0000-4000-8000-000000000042';
/** Otro vecino, este SOLO con lo que deja una importación por CSV (RES-2). */
const WS_SOLO_CSV = '0000000c-0000-4000-8000-000000000043';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  // Los dos vecinos llevan creador: sin él, `importarLecturasCsv`
  // moriría por falta de creador y la prueba de aislamiento pasaría por
  // el motivo equivocado, sin llegar a comprobar la conexión ajena.
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_VECINO}',   'vecino-resumen',  'Estudio vecino',  'COP', 'America/Bogota', 'es-CO', 'CO'),
           ('${WS_SOLO_CSV}', 'vecino-solo-csv', 'Estudio de CSVs', 'COP', 'America/Bogota', 'es-CO', 'CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (workspace_id, display_name, handle)
    VALUES ('${WS_VECINO}',   'Vecino',        'vecino'),
           ('${WS_SOLO_CSV}', 'Solo CSV',      'solo.csv')
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
    assert.equal(pasoDeBloque(30), 4);
    assert.equal(pasoDeBloque(90), 10);

    const mes = await enLaura((tx) => getViewsPorBloque(tx, { dias: 30 }));
    assert.equal(mes.paso, 4);
    assert.equal(mes.bloques.length, 7);

    const trimestre = await enLaura((tx) => getViewsPorBloque(tx, { dias: 90 }));
    assert.equal(trimestre.paso, 10);
    assert.equal(trimestre.bloques.length, 9);
    for (const b of trimestre.bloques) {
      assert.equal((Date.parse(b.fin) - Date.parse(b.inicio)) / 86_400_000, 9);
    }
    // Ordenados de más viejo a más nuevo.
    assert.ok(Date.parse(trimestre.bloques[0]!.inicio) < Date.parse(trimestre.bloques.at(-1)!.inicio));

    const dias = await enLaura((tx) => getViewsPorBloque(tx, { dias: 7 }));
    assert.equal(dias.paso, 1);
    assert.equal(dias.bloques.length, 7);
    assert.equal(dias.series.every((s) => s.data.length === 7), true);
  });

  test('con cualquier periodo, la última barra cae en la rejilla de etiquetas del kit', async () => {
    // BarChart etiqueta cada ceil(n/8) categorías y ADEMÁS fuerza la
    // última: si esa no cae en la rejilla, sus dos etiquetas se pisan.
    for (const dias of [7, 30, 90] as const) {
      const serie = await enLaura((tx) => getViewsPorBloque(tx, { dias }));
      assert.ok(
        ultimaEtiquetaEnLaRejilla(serie.bloques.length),
        `con ${dias} días salen ${serie.bloques.length} barras y la última etiqueta se pisa con la anterior`,
      );
    }
  });

  test('una conexión nueva no recorta la serie de las que llevan meses midiendo', async () => {
    const antes = await enLaura((tx) => getSeguidoresPorRed(tx, { dias: 90 }));
    assert.equal(antes.labels.length, 90);

    // Una quinta cuenta con UNA sola lectura, la de hoy.
    const nueva = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'tiktok', handle: 'recien.llegada' }));
    try {
      await enLaura((tx) =>
        tx.query(
          `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, views)
           SELECT $1, current_workspace_id(), max(a.day), 1200, 300 FROM account_metric_snapshot a`,
          [nueva.connectionId],
        ),
      );

      const despues = await enLaura((tx) => getSeguidoresPorRed(tx, { dias: 90 }));
      assert.equal(despues.labels.length, 90, 'la conexión joven recortó la ventana de todas');
      const bloques = await enLaura((tx) => getViewsPorBloque(tx, { dias: 90 }));
      assert.equal(bloques.bloques.length, 9, 'la conexión joven vació el gráfico de barras');
      // Y su red sigue sumando lo de siempre en el último punto, más la nueva.
      const tiktokAntes = antes.series.find((x) => x.platformId === 'tiktok')!.data.at(-1)!;
      const tiktokDespues = despues.series.find((x) => x.platformId === 'tiktok')!.data.at(-1)!;
      assert.equal(tiktokDespues, tiktokAntes + 1200);
    } finally {
      await t.admin(`DELETE FROM social_connection WHERE id = '${nueva.connectionId}'`);
    }
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
    // El conteo de posts va aparte: no entra en el camino crítico de la pantalla.
    assert.ok((await enLaura((tx) => contarPosts(tx))) >= 60);

    const vecino = await t.db.withWorkspace(WS_VECINO, (tx) => getCoberturaResumen(tx));
    assert.deepEqual(vecino, { conexiones: 0, conDatos: 0 });
    assert.equal(await t.db.withWorkspace(WS_VECINO, (tx) => contarPosts(tx)), 0);
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
    const antes = await enLaura((tx) => contarPosts(tx));
    const cuenta = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'facebook', handle: 'aparece' }));
    await enLaura((tx) =>
      importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'facebook', filas: [fila('fb_1'), fila('fb_2')] }),
    );
    const despues = await enLaura((tx) => contarPosts(tx));
    assert.equal(despues, antes + 2);

    const frescura = await enLaura((tx) => getFrescuraPorConexion(tx));
    const importada = frescura.find((f) => f.connectionId === cuenta.connectionId);
    assert.equal(importada?.ultimaFuente, 'csv_import');
    assert.ok(importada?.ultimaLecturaContenido);
  });

  test('la previsualización puede preguntar qué ids ya existen, sin traerse la tabla', async () => {
    const cuenta = await enLaura((tx) => asegurarCuentaCsv(tx, { red: 'instagram', handle: 'conocidos' }));
    await enLaura((tx) =>
      importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'instagram', filas: [fila('ig_ya_1'), fila('ig_ya_2')] }),
    );
    const hay = await enLaura((tx) => listExternalPostIds(tx, cuenta.connectionId, ['ig_ya_2', 'ig_nuevo']));
    assert.deepEqual(hay, ['ig_ya_2']);
    // Sin ids que preguntar, ni siquiera se consulta.
    assert.deepEqual(await enLaura((tx) => listExternalPostIds(tx, cuenta.connectionId, [])), []);
  });

  test('un workspace que SOLO importó un CSV ve cifras, no una pantalla en blanco', async () => {
    // El caso para el que existe RES-2: ni una fila de serie de cuenta,
    // solo post + post_metric_snapshot. Si el reloj del módulo mirase
    // únicamente account_metric_snapshot, aquí todo saldría null.
    const enCsv = <T,>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> => t.db.withWorkspace(WS_SOLO_CSV, fn);
    const cuenta = await enCsv((tx) => asegurarCuentaCsv(tx, { red: 'instagram', handle: 'solo.csv' }));
    await enCsv((tx) =>
      importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: 'instagram', filas: [fila('csv_1'), fila('csv_2')] }),
    );

    const cobertura = await enCsv((tx) => getCoberturaResumen(tx));
    assert.deepEqual(cobertura, { conexiones: 1, conDatos: 1 });

    const kpis = await enCsv((tx) => getResumenKpis(tx, { dias: 30 }));
    assert.ok(kpis.hasta !== null, 'el módulo tiene "hoy" aunque no haya serie de cuenta');
    assert.equal(kpis.posts, 2);
    assert.ok(kpis.nonFollowerReach.value !== null && kpis.nonFollowerReach.value > 0);
    assert.ok(kpis.savesPer1k.value !== null && kpis.savesPer1k.value > 0);
    // Lo que de verdad no se sabe sigue siendo null, no cero.
    assert.equal(kpis.followers.value, null);
    assert.equal(kpis.views.value, null);

    // Y la frescura sabe decir hasta cuándo llegan esos datos.
    const frescura = await enCsv((tx) => getFrescuraPorConexion(tx));
    assert.equal(frescura.length, 1);
    assert.equal(frescura[0]!.ultimoDiaCuenta, null);
    assert.ok(frescura[0]!.ultimaLecturaContenido);
    assert.equal(frescura[0]!.ultimaFuente, 'csv_import');
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
      /no existe en este workspace/,
    );
  });
});
