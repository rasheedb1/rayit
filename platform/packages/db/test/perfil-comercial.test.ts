/**
 * VEN-11 · el perfil comercial contra Postgres embebido con las
 * migraciones y el seed de Laura.
 *
 * El «terminado cuando» en la capa de datos:
 *   - con el seed, el perfil trae los cinco mejores videos con sus cifras
 *     y cada cifra lleva su fila de origen;
 *   - una narrativa con un claim inventado no se guarda;
 *   - cada llamada al modelo deja su fila en outbound_llm_call (0065);
 *   - nada cruza de un workspace a otro.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { templateNarrative, type NarrativeOutcome } from '@mc/core/outreach/narrativa';
import type { WorkspaceTx } from '../src/client.ts';
import {
  claimPerfilRecalc, computePerfil, getPerfilComercial, getPrimaryCreator, llmBudgetExhausted, PERFIL_RECALCULO_KEY,
  PERFIL_MAX_POSTS, PERFIL_RECALCULO_TTL_S, PerfilComercialError, readPerfilDataAsOf, readPerfilInputs, readPostCovers,
  recordProfileLlmCalls, releasePerfilRecalc, releaseProfileLlmReservation, reserveProfileLlmBudget, saveNarrativeEdit,
  savePerfilComercial,
} from '../src/queries/perfil-comercial.ts';
import { outboundHealth } from '../src/queries/outreach.ts';
import { CAMPAIGN_CAFE_ALMA, POST_D01_REEL_CAFE_ALMA, WORKSPACE_LAURA, openTestDb, type TestDb, SETUP_TIMEOUT } from './pglite.ts';

const CREADORA_LAURA = '00000002-0000-4000-8000-000000000003';
const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000fe11';

let t: TestDb;
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);

before(async () => {
  t = await openTestDb();
  await t.admin(`INSERT INTO workspace (id, name, slug) VALUES ('${WORKSPACE_AJENO}', 'Ajeno', 'ajeno-perfil') ON CONFLICT DO NOTHING`);
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

const plantilla = (perfil: Awaited<ReturnType<typeof computePerfil>>): NarrativeOutcome => ({
  text: templateNarrative(perfil), source: 'template', model: null, calls: [], fallback: 'no_model', issues: [],
});

test('con el seed, el perfil trae los cinco mejores videos con sus cifras y su origen', async () => {
  const perfil = await laura(async (tx) => {
    const creador = await getPrimaryCreator(tx);
    assert.equal(creador?.id, CREADORA_LAURA);
    return computePerfil(tx, CREADORA_LAURA, new Date('2026-09-25T10:00:00Z'));
  });
  assert.equal(perfil.performance.top.length, 5);
  const [primero] = perfil.performance.top;
  assert.equal(primero!.postId, POST_D01_REEL_CAFE_ALMA);
  assert.equal(primero!.title, 'Cold brew en casa en 3 pasos');
  assert.equal(primero!.outlierTier, 'breakout');
  assert.match(primero!.url ?? '', /^https:\/\//);
  const x = perfil.claims.find((c) => c.id === primero!.multipleClaimId)!;
  assert.deepEqual([x.value, x.source.table, x.source.id, x.source.field], [5.971, 'post_score', POST_D01_REEL_CAFE_ALMA, 'views_vs_median']);
  const views = perfil.claims.find((c) => c.id === primero!.viewsClaimId)!;
  assert.equal(views.value, 412000);
  // Ordenados de mayor a menor frente a su mediana.
  const xs = perfil.performance.top.map((v) => Number(perfil.claims.find((c) => c.id === v.multipleClaimId)!.value));
  assert.deepEqual(xs, [...xs].sort((a, b) => b - a));

  assert.deepEqual(perfil.performance.medians.map((m) => m.platformId), ['tiktok', 'instagram', 'facebook', 'youtube']);
  assert.equal(perfil.claims.find((c) => c.id === 'mediana-tiktok')!.value, 115446);
  const cafe = perfil.socialProof.find((c) => c.campaignId === CAMPAIGN_CAFE_ALMA)!;
  assert.equal(cafe.companyName, 'Café Alma');
  assert.deepEqual(cafe.claimIds.map((id) => perfil.claims.find((c) => c.id === id)!.value), [712000, 1240, 318, '8400000.00']);
  assert.ok(perfil.rates && perfil.rates.lines.length >= 4);
  assert.ok(perfil.audience.platformId);
  assert.ok(perfil.audience.lines.some((a) => a.dimension === 'gender'));
  assert.ok(perfil.audience.nonFollowers.length > 0);
  assert.ok(perfil.formats.pieces.length > 0 && perfil.formats.tone.length > 0);
  // Cada claim tiene fila de origen, con su uuid (desde 0083 ninguna lleva id de secuencia).
  for (const c of perfil.claims) assert.match(c.source.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, c.id);
  // Toda cifra leída de una tabla dice cuándo se leyó (los agregados de captions y del porqué son de este cálculo).
  const deEsteCalculo = new Set(['video.duration', 'why.group', 'why.rest', 'scored_videos', 'format.piece', 'format.content', 'tone', 'captions_read']);
  for (const c of perfil.claims) if (!deEsteCalculo.has(c.key)) assert.ok(c.source.asOf && !Number.isNaN(Date.parse(c.source.asOf)), c.id);
});

test('cada video se mide contra la mediana de su red en su corte: views ≈ veces × esa mediana', async () => {
  const perfil = await laura((tx) => computePerfil(tx, CREADORA_LAURA, new Date('2026-09-25T10:00:00Z')));
  const claim = (id: string | null) => perfil.claims.find((c) => c.id === id)!;
  for (const v of perfil.performance.top) {
    const base = claim(v.baselineClaimId);
    assert.ok(base, v.title);
    assert.equal(base.source.table, 'creator_baseline');
    assert.equal(base.params.platform, v.platformId);
    assert.equal(base.params.cutHours, v.cutHours, v.title);
    const x = Number(claim(v.multipleClaimId).value);
    const views = Number(claim(v.viewsClaimId).value);
    assert.ok(Math.abs(views / Number(base.value) - x) <= 0.01 * x, `${v.title}: ${views} / ${base.value} ≠ ${x}`);
  }
  // Las medianas de la cabecera dicen su propio corte.
  for (const m of perfil.performance.medians) assert.equal(claim(m.claimId).params.cutHours, m.cutHours);
});

test('con el seed, el porqué nunca se demuestra con el mismo video y cada agregado enlaza sus videos', async () => {
  const perfil = await laura((tx) => computePerfil(tx, CREADORA_LAURA, new Date('2026-09-25T10:00:00Z')));
  const claim = (id: string) => perfil.claims.find((c) => c.id === id)!;
  for (const v of perfil.performance.top) {
    assert.ok(v.why.reasons.length <= 1, v.title);
    for (const r of v.why.reasons) {
      const grupo = claim(r.groupClaimId);
      const resto = claim(r.restClaimId);
      assert.ok(!grupo.source.rows!.includes(v.postId) && !resto.source.rows!.includes(v.postId), v.title);
      assert.ok(grupo.source.rows!.length >= 3 && resto.source.rows!.length >= 3, v.title);
      assert.ok(Number(grupo.value) >= 1.5 * Number(resto.value), v.title);
    }
  }
  // Con el seed 0010 (el laboratorio de video marcó cinco videos que abren
  // con un reto), la demo enseña «Lo distingue» en al menos uno de los cinco.
  const conRazon = perfil.performance.top.filter((v) => v.why.reasons.length > 0);
  assert.ok(conRazon.length >= 1, 'ninguno de los cinco mejores tiene porqué');
  for (const v of conRazon) {
    assert.equal(v.why.hookSource, 'video_analysis', v.title);
    assert.deepEqual(v.why.reasons.map((r) => [r.axis, r.group]), [['hook', 'reto']], v.title);
  }
  // Los posts de los agregados vienen con título y enlace para «De dónde sale cada cifra».
  const indice = new Map(perfil.posts.map((p) => [p.postId, p]));
  const captions = claim('captions-leidos');
  for (const id of captions.source.rows!) assert.ok(indice.get(id)?.title, id);
  // La mediana de cada red enseña los videos que la forman: tantos como su muestra, de su red.
  for (const m of perfil.performance.medians) {
    const rows = claim(m.claimId).source.rows;
    assert.ok(rows && rows.length === m.sampleSize, `${m.platformId}: ${rows?.length} de ${m.sampleSize}`);
    for (const id of rows) assert.equal(indice.get(id)?.platformId, m.platformId, id);
  }
  // Y la mediana contra la que se midió cada uno de los mejores, también.
  for (const v of perfil.performance.top) {
    const base = claim(v.baselineClaimId!);
    assert.ok(base.source.rows && base.source.rows.length > 0, v.title);
  }
});

test('un recálculo a la vez: la marca se toma, se niega a un segundo, vence y se suelta al guardar', async () => {
  const ahora = new Date('2026-09-25T12:00:00Z');
  const primera = await laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA, ahora));
  await assert.rejects(
    laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA, new Date(ahora.getTime() + 30_000))),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'recalc_in_progress',
  );
  // Una acción cortada no la suelta: vence sola.
  const segunda = await laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA, new Date(ahora.getTime() + (PERFIL_RECALCULO_TTL_S + 1) * 1000)));
  assert.notEqual(segunda.token, primera.token);
  // Soltar con el token vencido no le quita la marca al que la tiene ahora.
  await laura((tx) => releasePerfilRecalc(tx, CREADORA_LAURA, primera.token));
  const marca = async () => (await laura(async (tx) => (await tx.query<{ m: unknown }>(
    `SELECT media_kit -> $2::text AS m FROM creator_profile WHERE id = $1`, [CREADORA_LAURA, PERFIL_RECALCULO_KEY])).rows[0]!.m));
  assert.ok(await marca());
  // Guardar con su token la suelta en la misma transacción.
  await laura(async (tx) => {
    const perfil = await computePerfil(tx, CREADORA_LAURA);
    return savePerfilComercial(tx, perfil, plantilla(perfil), { recalcToken: segunda.token });
  });
  assert.equal(await marca(), null);
});

test('un recálculo que pasó del TTL no pisa al que tomó su marca vencida', async () => {
  const ahora = new Date('2026-09-26T12:00:00Z');
  const lento = await laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA, ahora));
  const nuevo = await laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA, new Date(ahora.getTime() + (PERFIL_RECALCULO_TTL_S + 1) * 1000)));
  const guardado = await laura(async (tx) => {
    const perfil = await computePerfil(tx, CREADORA_LAURA);
    return savePerfilComercial(tx, perfil, plantilla(perfil), { recalcToken: nuevo.token, now: new Date('2026-09-26T12:02:00Z') });
  });
  // El lento termina después: su guardado se rechaza y el del nuevo se queda.
  await assert.rejects(
    laura(async (tx) => {
      const perfil = await computePerfil(tx, CREADORA_LAURA);
      return savePerfilComercial(tx, perfil, plantilla(perfil), { recalcToken: lento.token, now: new Date('2026-09-26T12:03:00Z') });
    }),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'recalc_in_progress',
  );
  const vigente = await laura((tx) => getPerfilComercial(tx, CREADORA_LAURA));
  assert.equal(vigente?.narrative.writtenAt, guardado.narrative.writtenAt);
});

test('recalcular no pisa una edición guardada mientras tanto', async () => {
  const doc = await laura(async (tx) => {
    const perfil = await computePerfil(tx, CREADORA_LAURA);
    return savePerfilComercial(tx, perfil, plantilla(perfil));
  });
  // Empieza el recálculo: se anota la narrativa que había.
  const marca = await laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA));
  assert.equal(marca.narrativeWrittenAt, doc.narrative.writtenAt);
  // Mientras el modelo escribe, otra pestaña guarda una edición.
  const editada = await laura((tx) =>
    saveNarrativeEdit(tx, CREADORA_LAURA, 'Mi mediana en TikTok es de [claim:mediana-tiktok] views.', doc.narrative.writtenAt));
  await assert.rejects(
    laura(async (tx) => {
      const perfil = await computePerfil(tx, CREADORA_LAURA);
      return savePerfilComercial(tx, perfil, plantilla(perfil), { expectedWrittenAt: marca.narrativeWrittenAt, recalcToken: marca.token });
    }),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'stale_edit',
  );
  assert.deepEqual((await laura((tx) => getPerfilComercial(tx, CREADORA_LAURA)))!.narrative, editada.narrative);
  await laura((tx) => releasePerfilRecalc(tx, CREADORA_LAURA, marca.token));
  // Si la edición es la que se vio al empezar, recalcular la reemplaza (lo confirmó quien pulsó).
  const otra = await laura((tx) => claimPerfilRecalc(tx, CREADORA_LAURA));
  assert.equal(otra.narrativeWrittenAt, editada.narrative.writtenAt);
  const nuevo = await laura(async (tx) => {
    const perfil = await computePerfil(tx, CREADORA_LAURA);
    return savePerfilComercial(tx, perfil, plantilla(perfil), { expectedWrittenAt: otra.narrativeWrittenAt, recalcToken: otra.token });
  });
  assert.equal(nuevo.narrative.source, 'template');
});

test('el perfil se guarda en media_kit.perfil_comercial sin tocar las demás claves, y se lee igual', async () => {
  const doc = await laura(async (tx) => {
    const perfil = await computePerfil(tx, CREADORA_LAURA);
    return savePerfilComercial(tx, perfil, plantilla(perfil));
  });
  const leido = await laura((tx) => getPerfilComercial(tx, CREADORA_LAURA));
  assert.deepEqual(leido, doc);
  assert.equal(leido!.narrative.source, 'template');
  const [fila] = await laura(async (tx) => (await tx.query<{ tagline: string | null }>(
    `SELECT media_kit ->> 'tagline' AS tagline FROM creator_profile WHERE id = $1`, [CREADORA_LAURA])).rows);
  assert.equal(fila!.tagline, 'Cocina fácil, sin vueltas');
  const datos = await laura((tx) => readPerfilDataAsOf(tx, CREADORA_LAURA));
  assert.ok(datos && !Number.isNaN(Date.parse(datos)));
});

test('una narrativa con un claim inventado no se guarda', async () => {
  await assert.rejects(
    laura(async (tx) => {
      const perfil = await computePerfil(tx, CREADORA_LAURA);
      const falsa = plantilla(perfil);
      falsa.text = falsa.text.replace(/\[claim:mediana-[a-z]+\]/, '[claim:mediana-inventada]');
      return savePerfilComercial(tx, perfil, falsa);
    }),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'invalid_narrative'
      && e.issues.some((i) => i.code === 'unknown_claim' && i.id === 'mediana-inventada'),
  );
});

test('cada llamada al modelo deja su fila en outbound_llm_call con propósito profile y su costo', async () => {
  await laura((tx) => recordProfileLlmCalls(tx, [
    { model: 'claude-sonnet-5', inputTokens: 3000, outputTokens: 400 },
    { model: 'claude-sonnet-5', inputTokens: 3100, outputTokens: 380 },
  ]));
  const filas = await laura(async (tx) => (await tx.query<{ model: string; input_tokens: number; cost: string }>(
    `SELECT model, input_tokens, cost::text AS cost FROM outbound_llm_call WHERE purpose = 'profile' ORDER BY input_tokens`)).rows);
  assert.deepEqual(filas, [
    { model: 'claude-sonnet-5', input_tokens: 3000, cost: '0.010000' },
    { model: 'claude-sonnet-5', input_tokens: 3100, cost: '0.010000' },
  ]);
  assert.equal(await laura((tx) => llmBudgetExhausted(tx)), false);
});

test('«Recalcular» aparta su costo como el worker: cuenta las reservas abiertas y suelta la suya al registrar', async () => {
  const { llm } = await laura((tx) => outboundHealth(tx, 24));
  const libre = llm.dailyCap - llm.spentToday;
  assert.ok(libre > 0.05, 'la prueba necesita saldo');
  // El worker ya apartó casi todo: queda un centavo.
  const WORKER = '0000000f-0000-4000-8000-00000000a001';
  await t.admin(`INSERT INTO outbound_llm_reservation (id, workspace_id, purpose, amount)
                 VALUES ('${WORKER}', '${WORKSPACE_LAURA}', 'generate', ${(libre - 0.01).toFixed(6)})`);
  try {
    assert.equal(await laura((tx) => reserveProfileLlmBudget(tx, 0.044)), null, 'con un centavo no se llama al modelo');
    assert.equal(await laura((tx) => llmBudgetExhausted(tx)), false, 'un centavo todavía no es el tope');
    // La web no suelta las del worker: solo las suyas (purpose profile).
    await laura((tx) => releaseProfileLlmReservation(tx, WORKER));
    const siguen = await laura(async (tx) => (await tx.query(`SELECT 1 FROM outbound_llm_reservation WHERE id = $1`, [WORKER])).rows.length);
    assert.equal(siguen, 1);
    // Y no escribe la tabla a mano.
    await assert.rejects(laura((tx) => tx.query(
      `INSERT INTO outbound_llm_reservation (workspace_id, purpose, amount) VALUES (current_workspace_id(), 'profile', 0)`)));
  } finally {
    await t.admin(`DELETE FROM outbound_llm_reservation WHERE id = '${WORKER}'`);
  }
  const id = await laura((tx) => reserveProfileLlmBudget(tx, 0.044));
  assert.ok(id, 'con saldo aparta');
  const fila = await laura(async (tx) =>
    (await tx.query<{ purpose: string; amount: string }>(`SELECT purpose, amount::text AS amount FROM outbound_llm_reservation WHERE id = $1`, [id])).rows[0]);
  assert.deepEqual({ ...fila }, { purpose: 'profile', amount: '0.044000' });
  await laura((tx) => recordProfileLlmCalls(tx, [{ model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 10 }], id));
  const quedan = await laura(async (tx) => (await tx.query(`SELECT 1 FROM outbound_llm_reservation WHERE id = $1`, [id])).rows.length);
  assert.equal(quedan, 0, 'registrar la llamada suelta su reserva');
});

test('la edición a mano pasa el mismo verificador y no pisa una versión más nueva', async () => {
  const doc = await laura(async (tx) => {
    const perfil = await computePerfil(tx, CREADORA_LAURA);
    return savePerfilComercial(tx, perfil, plantilla(perfil));
  });
  const texto = 'Soy Laura. Mi mediana en TikTok es de [claim:mediana-tiktok] views.';
  await assert.rejects(
    laura((tx) => saveNarrativeEdit(tx, CREADORA_LAURA, `${texto} Y 3 millones de fans.`, doc.narrative.writtenAt)),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'invalid_narrative' && e.issues[0]?.code === 'bare_number',
  );
  // Con letras tampoco: «dos millones de fans» es una cifra sin origen.
  await assert.rejects(
    laura((tx) => saveNarrativeEdit(tx, CREADORA_LAURA, `${texto} Tengo dos millones de fans.`, doc.narrative.writtenAt)),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'invalid_narrative'
      && e.issues.some((i) => i.code === 'number_word' && i.text === 'millones'),
  );
  await assert.rejects(
    laura((tx) => saveNarrativeEdit(tx, CREADORA_LAURA, texto, '2020-01-01T00:00:00.000Z')),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'stale_edit',
  );
  const editado = await laura((tx) => saveNarrativeEdit(tx, CREADORA_LAURA, `  ${texto}\r\n`, doc.narrative.writtenAt));
  assert.deepEqual([editado.narrative.source, editado.narrative.text], ['edited', texto]);
  assert.deepEqual(editado.perfil, doc.perfil, 'editar la narrativa no toca las cifras');
});

test('otro workspace no ve ni escribe el perfil de Laura', async () => {
  const ajeno = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_AJENO, fn);
  assert.equal(await ajeno((tx) => getPerfilComercial(tx, CREADORA_LAURA)), null);
  await assert.rejects(ajeno((tx) => computePerfil(tx, CREADORA_LAURA)), (e: unknown) => e instanceof PerfilComercialError && e.code === 'creator_not_found');
  const perfil = await laura((tx) => computePerfil(tx, CREADORA_LAURA));
  await assert.rejects(
    ajeno((tx) => savePerfilComercial(tx, perfil, plantilla(perfil))),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'creator_not_found',
  );
  await assert.rejects(
    ajeno((tx) => saveNarrativeEdit(tx, CREADORA_LAURA, 'Hola.', 'x')),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'creator_not_found',
  );
  await assert.rejects(
    ajeno((tx) => claimPerfilRecalc(tx, CREADORA_LAURA)),
    (e: unknown) => e instanceof PerfilComercialError && e.code === 'creator_not_found',
  );
  assert.equal(await ajeno((tx) => readPerfilDataAsOf(tx, CREADORA_LAURA)), null);
});

test('con el seed, los cinco mejores tienen portada, y la pantalla la lee viva por id', async () => {
  const perfil = await laura((tx) => computePerfil(tx, CREADORA_LAURA, new Date('2026-09-25T10:00:00Z')));
  // La demo trae portadas (seed 0007): una ruta de la aplicación, que el perfil acepta.
  for (const v of perfil.performance.top) assert.match(v.coverUrl ?? '', /^\/demo\/portadas\/[1-8]\.svg$/, v.title);
  const ids = perfil.performance.top.map((v) => v.postId);
  const vivas = await laura((tx) => readPostCovers(tx, [...ids, 'no-es-un-uuid']));
  assert.deepEqual(Object.keys(vivas).sort(), [...ids].sort());
  // La sincronización trae una portada nueva (las firmadas caducan): se lee la de hoy, no la del cálculo.
  await t.admin(`UPDATE post SET cover_url = 'https://p16.tiktokcdn.com/nueva.jpg' WHERE id = '${POST_D01_REEL_CAFE_ALMA}'`);
  try {
    const hoy = await laura((tx) => readPostCovers(tx, [POST_D01_REEL_CAFE_ALMA]));
    assert.equal(hoy[POST_D01_REEL_CAFE_ALMA], 'https://p16.tiktokcdn.com/nueva.jpg');
    // Una portada sin esquema no llega a un src.
    await t.admin(`UPDATE post SET cover_url = 'cdn.example.com/x.jpg' WHERE id = '${POST_D01_REEL_CAFE_ALMA}'`);
    assert.equal((await laura((tx) => readPostCovers(tx, [POST_D01_REEL_CAFE_ALMA])))[POST_D01_REEL_CAFE_ALMA], null);
  } finally {
    await t.admin(`UPDATE post SET cover_url = '${perfil.performance.top.find((v) => v.postId === POST_D01_REEL_CAFE_ALMA)!.coverUrl}' WHERE id = '${POST_D01_REEL_CAFE_ALMA}'`);
  }
  // Otro workspace no ve las portadas de Laura.
  assert.deepEqual(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => readPostCovers(tx, ids)), {});
});

test('un breakout viejo entra entre los mejores aunque ya no esté entre los posts recientes', async () => {
  const hecho = new Error('deshacer');
  await assert.rejects(
    laura(async (tx) => {
      // Más publicaciones nuevas que PERFIL_MAX_POSTS: el reel de Café Alma (agosto) queda fuera de los recientes.
      await tx.query(
        `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, url, media_type, surface, title, caption, published_at)
         SELECT current_workspace_id(), $1, c.id, c.platform_id, 'relleno-' || g, 'https://www.tiktok.com/@laura/video/r' || g,
                'video', 'feed', 'Relleno ' || g, 'Relleno ' || g, now() + make_interval(mins => g)
           FROM generate_series(1, $2::int) g
           JOIN social_connection c ON c.creator_id = $1 AND c.platform_id = 'tiktok'`,
        [CREADORA_LAURA, PERFIL_MAX_POSTS + 5],
      );
      const e = (await readPerfilInputs(tx, CREADORA_LAURA))!;
      assert.equal(e.posts.length, PERFIL_MAX_POSTS);
      assert.ok(!e.posts.some((p) => p.id === POST_D01_REEL_CAFE_ALMA), 'el reel ya no está entre los recientes');
      assert.ok(e.scoredPosts!.some((p) => p.id === POST_D01_REEL_CAFE_ALMA), 'sí entre los puntuados del historial');
      assert.ok(e.scoredPosts!.every((p) => p.score?.viewsVsMedian !== null));
      const perfil = await computePerfil(tx, CREADORA_LAURA, new Date('2026-09-25T10:00:00Z'));
      assert.equal(perfil.performance.top[0]!.postId, POST_D01_REEL_CAFE_ALMA);
      // «Entre N videos con puntaje» cuenta todo el historial con puntaje.
      const puntuados = perfil.claims.find((c) => c.id === perfil.performance.scoredClaimId)!;
      assert.equal(puntuados.value, e.scoredPosts!.length);
      throw hecho;
    }),
    (err: unknown) => err === hecho,
  );
});
