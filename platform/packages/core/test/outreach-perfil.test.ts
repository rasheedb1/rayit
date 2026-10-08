/**
 * VEN-11 · el perfil comercial: el cálculo puro (claims, los cinco
 * mejores y su porqué, audiencia, formatos y tono, prueba social,
 * tarifas) y lo que se lee de los captions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPerfil, claimById, claimSlug, coverSrcOrNull, webUrlOrNull, cutOf, genderCode, shortId, whyContrast, WHY_MIN_GROUP, WHY_MIN_LIFT, type PerfilComercial,
} from '../src/outreach/perfil.ts';
import {
  contentOf, durationBucketOf, durationVsTypical, hookFromAnalysis, hookOf, pieceOf, toneTraitsOf,
} from '../src/outreach/perfil-captions.ts';
import { median, medianOrNull } from '../src/scoring.ts';
import { parseStoredPerfil, type StoredPerfil } from '../src/outreach/perfil-guardado.ts';
import { templateNarrative, verifyNarrative } from '../src/outreach/narrativa.ts';
import { entradasConVideosLargos, entradasLaura } from './fixtures/perfil-entradas.ts';

/** Todos los ids que citan las secciones: cada uno tiene que estar en claims. */
function idsCitados(p: PerfilComercial): string[] {
  const ids: (string | null)[] = [
    ...p.identity.networks.map((n) => n.followersClaimId),
    ...p.audience.lines.map((a) => a.claimId),
    ...p.audience.nonFollowers.map((n) => n.claimId),
    ...p.performance.medians.map((m) => m.claimId),
    p.performance.scoredClaimId,
    ...p.performance.top.flatMap((v) => [v.multipleClaimId, v.viewsClaimId, v.baselineClaimId, v.durationClaimId]),
    ...p.performance.top.flatMap((v) => v.why.reasons.flatMap((r) => [r.groupClaimId, r.restClaimId])),
    ...p.formats.pieces.map((f) => f.claimId),
    ...p.formats.contents.map((f) => f.claimId),
    ...p.formats.tone.map((f) => f.claimId),
    p.formats.captionsClaimId,
    ...p.socialProof.flatMap((c) => c.claimIds),
    ...(p.rates?.lines ?? []).flatMap((l) => [l.lowClaimId, l.highClaimId]),
  ];
  return ids.filter((x): x is string => x !== null);
}

test('los cinco mejores videos salen ordenados por veces su mediana, con sus cifras y su origen', () => {
  const p = buildPerfil(entradasLaura());
  assert.equal(p.performance.top.length, 5);
  assert.deepEqual(
    p.performance.top.map((v) => v.title),
    ['Cold brew en casa en 3 pasos', 'La arepa que se hace sin plancha', 'Tres desayunos con dos ingredientes',
      'El cold brew que me salva las mañanas', 'Pasta cremosa en cuatro minutos'],
  );
  const primero = p.performance.top[0]!;
  assert.equal(primero.outlierTier, 'breakout');
  // La portada viaja con el video; el que no la tiene queda en null (la pantalla pinta un hueco).
  assert.equal(primero.coverUrl, 'https://example.com/d01.jpg');
  assert.equal(p.performance.top[1]!.coverUrl, null);
  const x = claimById(p, primero.multipleClaimId)!;
  assert.deepEqual(x, {
    id: 'video-000000000d01-x', kind: 'multiple', key: 'video.multiple',
    params: { platform: 'instagram', title: 'Cold brew en casa en 3 pasos', cutHours: 720 },
    value: 5.971, unit: 'x',
    source: {
      table: 'post_score', id: '00000002-0000-4000-8000-000000000d01', field: 'views_vs_median', url: 'https://example.com/d01',
      asOf: '2026-09-25T00:00:00.000Z',
    },
  });
  assert.equal(claimById(p, primero.viewsClaimId)!.value, 412000);
  assert.equal(claimById(p, primero.viewsClaimId)!.source.field, 'views_at_cut');
  assert.equal(claimById(p, primero.durationClaimId)!.source.table, 'post');
  // Cada video dice su corte y la mediana contra la que se midió: 412 000 / 69 000 ≈ 5,97.
  assert.equal(primero.cutHours, 720);
  const base = claimById(p, primero.baselineClaimId)!;
  assert.deepEqual([base.id, base.value, base.params.cutHours, base.source.table], ['mediana-instagram-ba5207200001', 69000, 720, 'creator_baseline']);
  // Si se midió contra la misma línea base de la mediana del perfil, es el mismo claim.
  assert.equal(p.performance.top[2]!.baselineClaimId, 'mediana-instagram');
  // El que no tiene puntaje no compite.
  assert.ok(!p.performance.top.some((v) => v.postId.endsWith('d40')));
  assert.equal(claimById(p, p.performance.scoredClaimId)!.value, 7);
});

test('cada cifra de cada sección es un claim de la lista, sin ids repetidos', () => {
  const p = buildPerfil(entradasLaura());
  const ids = new Set(p.claims.map((c) => c.id));
  assert.equal(ids.size, p.claims.length);
  for (const id of idsCitados(p)) assert.ok(ids.has(id), id);
  // Y ninguno sobra: todo claim lo cita alguna sección.
  assert.deepEqual(new Set(idsCitados(p)), ids);
});

test('el perfil es determinista: las mismas filas dan los mismos ids y el mismo documento', () => {
  assert.deepEqual(buildPerfil(entradasLaura()), buildPerfil(entradasLaura()));
});

test('con siete videos (el fixture), ningún rasgo alcanza: el porqué no se inventa y describe el video', () => {
  const p = buildPerfil(entradasLaura());
  // Siete videos con puntaje: ningún grupo tiene tres OTROS videos y tres del otro lado con la mitad más de rendimiento.
  for (const v of p.performance.top) assert.deepEqual(v.why.reasons, [], v.title);
  assert.ok(!p.claims.some((c) => c.key === 'why.group' || c.key === 'why.rest'));
});

test('el porqué deja fuera al video: su grupo son los OTROS videos con el rasgo, y sale la razón más fuerte', () => {
  const p = buildPerfil(entradasConVideosLargos());
  const breakout = p.performance.top[0]!;
  assert.equal(breakout.title, 'Cold brew en casa en 3 pasos');
  // Una sola razón, la de mayor contraste: los otros cortos (3,71; 2,662; 2,469; 2,02) frente a los que no lo son.
  assert.deepEqual(breakout.why.reasons.map((r) => `${r.axis}:${r.group}`), ['duration:corto']);
  const [razon] = breakout.why.reasons;
  const grupo = claimById(p, razon!.groupClaimId)!;
  const resto = claimById(p, razon!.restClaimId)!;
  assert.equal(grupo.id, 'porque-000000000d01-duracion-corto');
  assert.equal(resto.id, 'porque-000000000d01-duracion-corto-resto');
  assert.equal(grupo.value, (2.469 + 2.662) / 2);
  // El video que se explica no está en ninguna de las dos medianas.
  assert.ok(!grupo.source.rows!.includes(breakout.postId));
  assert.ok(!resto.source.rows!.includes(breakout.postId));
  assert.equal(grupo.source.rows!.length, 4);
  assert.equal(resto.value, 0.75);
  assert.equal(grupo.params.title, breakout.title);
  // Cada video tiene sus propias medianas: la arepa (también corta) se mide sin ella misma y con el cold brew dentro.
  const arepa = p.performance.top[1]!;
  const suya = claimById(p, arepa.why.reasons[0]!.groupClaimId)!;
  assert.equal(suya.id, 'porque-000000000d06-duracion-corto');
  assert.ok(suya.source.rows!.includes(breakout.postId) && !suya.source.rows!.includes(arepa.postId));
  // Los posts que forman los agregados vienen en el índice, con título y enlace.
  const indice = new Set(p.posts.map((x) => x.postId));
  for (const id of grupo.source.rows!) assert.ok(indice.has(id), id);
});

test('whyContrast: un grupo de dos, con el video a 2,7× y el otro a 1,1×, no es razón', () => {
  const it = (id: string, key: string | null, x: number) => ({ id, key, x });
  // El caso de r2: «Tus listas: 1,9× frente a 1×», donde el 1,9× lo ponía el mismo video.
  const items = [it('yo', 'lista', 2.7), it('otra', 'lista', 1.1), it('a', 'directo', 1), it('b', 'directo', 1), it('c', 'error', 0.9), it('d', 'pregunta', 1.2)];
  assert.equal(whyContrast(items, 'yo', 'lista'), null);
  // Aunque se bajara el mínimo a uno, sin el video el grupo rinde como el resto.
  assert.equal(whyContrast(items, 'yo', 'lista', { minGroup: 1 }), null);
  assert.equal(WHY_MIN_GROUP, 3);
  assert.equal(WHY_MIN_LIFT, 1.5);
});

test('whyContrast: tamaño mínimo sin contar el video, cuánto supera al resto, excluidos y sin clave', () => {
  const it = (id: string, key: string | null, x: number) => ({ id, key, x });
  const items = [
    it('yo', 'reel', 9), it('a', 'reel', 4), it('b', 'reel', 3), it('c', 'reel', 3.5),
    it('d', 'short', 1), it('e', 'short', 1.2), it('f', 'otro', 5), it('g', 'short', 2), it('h', null, 99),
  ];
  assert.deepEqual(whyContrast(items, 'yo', 'reel'), {
    key: 'reel', ids: ['a', 'b', 'c'], median: 3.5, restIds: ['d', 'e', 'f', 'g'], restMedian: 1.6, lift: 3.5 / 1.6,
  });
  // Con un reel menos, quedan dos OTROS: no alcanza.
  assert.equal(whyContrast(items.filter((i) => i.id !== 'c'), 'yo', 'reel'), null);
  // 'otro' no puede ser razón, y un video sin clave tampoco.
  assert.equal(whyContrast(items, 'f', 'otro', { exclude: ['otro'] }), null);
  assert.equal(whyContrast(items, 'h', null), null);
  // Un rasgo que tienen todos no tiene resto.
  assert.equal(whyContrast(items.map((i) => ({ ...i, key: 'breve' })), 'yo', 'breve'), null);
  // Por debajo de la mitad más, no es razón: 1,4 veces.
  const flojo = [it('yo', 'x', 5), it('a', 'x', 1.4), it('b', 'x', 1.4), it('c', 'x', 1.4), it('d', 'y', 1), it('e', 'y', 1), it('f', 'y', 1)];
  assert.equal(whyContrast(flojo, 'yo', 'x'), null);
});

test('el porqué describe el video: gancho, pieza, tipo y duración', () => {
  const p = buildPerfil(entradasLaura());
  const [breakout, arepa, desayunos, coldbrew, pasta] = p.performance.top;
  assert.deepEqual({ ...breakout!.why, reasons: [] }, {
    hook: 'promesa', hookSource: 'caption', piece: 'reel', content: 'colaboracion', duration: 'corto', durationVsTypical: 'similar', reasons: [],
  });
  assert.equal(arepa!.why.hook, 'promesa');
  assert.equal(arepa!.why.piece, 'tiktok');
  assert.equal(desayunos!.why.hook, 'lista');
  assert.equal(desayunos!.why.content, 'lista');
  assert.equal(coldbrew!.why.hook, 'historia');
  assert.equal(coldbrew!.why.content, 'colaboracion');
  assert.equal(pasta!.why.piece, 'short');
  assert.equal(pasta!.why.duration, 'medio');
  // La mediana de TikTok es 38 s (34, 34, 38, 60): la arepa, con 34, es «similar» por poco.
  assert.equal(arepa!.why.durationVsTypical, 'similar');
});

test('el gancho del laboratorio de video gana al del caption', () => {
  const e = entradasLaura();
  e.posts[0]!.hookType = 'question';
  const p = buildPerfil(e);
  assert.equal(p.performance.top[0]!.why.hook, 'pregunta');
  assert.equal(p.performance.top[0]!.why.hookSource, 'video_analysis');
});

test('la audiencia es la de la red con más seguidores que tenga demografía, sin «otros» en países', () => {
  const p = buildPerfil(entradasLaura());
  assert.equal(p.audience.platformId, 'tiktok');
  assert.deepEqual(
    p.audience.lines.map((a) => `${a.dimension}:${a.bucket}`),
    ['age:25-34', 'age:18-24', 'age:35-44', 'gender:F', 'gender:M', 'country:CO', 'country:MX'],
  );
  const f = claimById(p, p.audience.lines.find((a) => a.bucket === 'F')!.claimId)!;
  assert.equal(f.id, 'audiencia-tiktok-genero-f');
  // Sin texto en core: clave y parámetros; la pantalla y el prompt lo escriben.
  assert.deepEqual([f.key, f.params], ['audience.gender', { platform: 'tiktok', bucket: 'F' }]);
  assert.deepEqual(f.source, { table: 'audience_breakdown', id: 'a5', field: 'share', asOf: '2026-09-24' });
  assert.equal(claimById(p, 'no-seguidores-tiktok')!.source.asOf, '2026-09-24T06:00:00.000Z');
  // La mediana de no seguidores que no existe no se inventa.
  assert.deepEqual(p.audience.nonFollowers.map((n) => n.platformId), ['tiktok']);
});

test('dos cuentas en la misma red y una revocada: el perfil se arma, con ids únicos y la plantilla verificada', () => {
  const e = entradasLaura();
  e.connections = [
    ...e.connections,
    // Una segunda cuenta de TikTok, más chica: su id lleva el de la cuenta.
    { id: '00000002-0000-4000-8000-0000000000c9', platformId: 'tiktok', handle: 'laura.recetas', status: 'active', followers: 12000, followersSnapshotId: '00000000-0000-4000-8000-0000000009a9', followersDay: '2026-09-24' },
    // Una vieja revocada, con más seguidores: no es una red conectada.
    { id: '00000002-0000-4000-8000-0000000000ca', platformId: 'tiktok', handle: 'laura.vieja', status: 'revoked', followers: 900000, followersSnapshotId: '00000000-0000-4000-8000-0000000009aa', followersDay: '2025-01-01' },
  ];
  // Su demografía tampoco entra.
  e.audience = [...e.audience, { id: 'a99', platformId: 'tiktok', connectionId: '00000002-0000-4000-8000-0000000000ca', dimension: 'gender', bucket: 'M', share: 0.9, day: '2025-01-01' }];
  const p = buildPerfil(e);
  const ids = p.claims.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    p.identity.networks.filter((n) => n.platformId === 'tiktok').map((n) => [n.handle, n.followersClaimId]),
    [['laura.cocinafacil', 'seguidores-tiktok'], ['laura.recetas', 'seguidores-tiktok-0000000000c9']],
  );
  assert.ok(!p.identity.networks.some((n) => n.handle === 'laura.vieja'));
  assert.equal(claimById(p, 'seguidores-tiktok')!.value, 243000);
  assert.ok(!p.audience.lines.some((a) => claimById(p, a.claimId)!.source.id === 'a99'));
  for (const id of idsCitados(p)) assert.ok(ids.includes(id), id);
  assert.equal(verifyNarrative(templateNarrative(p), p).ok, true);
});

test('identidad, medianas por red y tarifas llevan su fila de origen', () => {
  const p = buildPerfil(entradasLaura());
  assert.deepEqual(p.identity.networks.map((n) => n.platformId), ['tiktok', 'instagram', 'youtube']);
  assert.equal(p.identity.networks[2]!.followersClaimId, null);
  assert.deepEqual(claimById(p, 'seguidores-tiktok')!.source, { table: 'account_metric_snapshot', id: '00000000-0000-4000-8000-0000000009a2', field: 'followers', asOf: '2026-09-24' });
  assert.deepEqual(p.performance.medians.map((m) => [m.platformId, m.cutHours]), [['tiktok', 168], ['instagram', 168], ['youtube', 168]]);
  assert.deepEqual(claimById(p, 'mediana-tiktok')!.source, { table: 'creator_baseline', id: 'b-tt', field: 'median_views', asOf: '2026-09-25T00:00:00.000Z' });
  const tarifa = claimById(p, p.rates!.lines[0]!.lowClaimId)!;
  assert.equal(tarifa.kind, 'money');
  assert.equal(tarifa.value, '5200000.00');
  assert.equal(tarifa.unit, 'COP');
});

test('la prueba social solo trae campañas con alguna cifra, y el dinero va en decimal con su moneda', () => {
  const p = buildPerfil(entradasLaura());
  assert.deepEqual(p.socialProof.map((c) => c.companyName), ['Café Alma', 'Hogar Lindo']);
  assert.deepEqual(p.socialProof[0]!.claimIds, ['campana-000000ca0001-views', 'campana-000000ca0001-seguidores-marca']);
  const ingresos = claimById(p, 'campana-000000ca0004-ingresos')!;
  assert.deepEqual([ingresos.value, ingresos.unit, ingresos.source.field], ['1250000.50', 'COP', 'attributed_revenue']);
});

test('formatos y tono salen de los captions, con las filas que los sostienen', () => {
  const p = buildPerfil(entradasLaura());
  assert.equal(p.formats.pieces[0]!.key, 'tiktok');
  assert.equal(claimById(p, p.formats.pieces[0]!.claimId)!.value, 4);
  assert.ok(p.formats.contents.some((c) => c.key === 'colaboracion'));
  const emojis = p.formats.tone.find((t) => t.key === 'emojis')!;
  const c = claimById(p, emojis.claimId)!;
  assert.equal(c.kind, 'share');
  assert.equal(c.value, 6 / 8);
  assert.equal(c.source.rows!.length, 6);
  assert.equal(claimById(p, p.formats.captionsClaimId)!.value, 8);
});

test('lectura de captions: gancho, pieza, contenido, duración y tono', () => {
  assert.equal(hookOf(null, 'Reto: arepa sin plancha'), 'reto');
  assert.equal(hookOf('¿Qué cocino hoy?', null), 'pregunta');
  assert.equal(hookOf('Qué cocino un lunes', null), 'pregunta');
  assert.equal(hookOf('Nunca laves así el arroz', null), 'error');
  assert.equal(hookOf('Cinco cenas rápidas', null), 'lista');
  assert.equal(hookOf('Pan sin horno', null), 'promesa');
  assert.equal(hookOf('Lo que como en un día', null), 'directo');
  assert.equal(hookOf(null, '\n\n  Mi abuela y yo  \nsegunda línea'), 'historia');
  assert.equal(hookOf(null, null), 'directo');
  assert.equal(hookFromAnalysis('curiosity_gap'), null);
  assert.equal(pieceOf('instagram', 'story', 'story'), 'historia');
  assert.equal(pieceOf('facebook', 'feed', 'video'), 'video');
  assert.equal(contentOf('Receta de pan', null, false), 'tutorial');
  assert.equal(contentOf('Pan', 'Con @marca', false), 'colaboracion');
  assert.equal(contentOf('Pan', 'Hoy pan', false), 'otro');
  assert.deepEqual([durationBucketOf(10), durationBucketOf(45), durationBucketOf(46), durationBucketOf(200), durationBucketOf(null)], ['muy_corto', 'corto', 'medio', 'largo', null]);
  assert.deepEqual([durationVsTypical(30, 40), durationVsTypical(40, 40), durationVsTypical(50, 40), durationVsTypical(50, null)], ['mas_corto', 'similar', 'mas_largo', null]);
  assert.equal(medianOrNull([3, 1, 2]), 2);
  assert.equal(medianOrNull([1, 2, 3, 4]), 2.5);
  assert.equal(medianOrNull([]), null);
  assert.equal(medianOrNull([Number.NaN, 4]), 4);
  // La de scoring.ts sigue devolviendo 0 en vacío: sus llamadores cuentan con eso.
  assert.equal(median([]), 0);
  assert.deepEqual(toneTraitsOf('¿Tú qué le pones? 🍳 #arepa', ['arepa']), ['emojis', 'tutea', 'preguntas', 'breve', 'hashtags']);
  assert.deepEqual(toneTraitsOf('   ', []), []);
});

test('cortes y géneros: lo que la pantalla no convierte a mano', () => {
  assert.deepEqual([cutOf(24), cutOf(72), cutOf(168), cutOf(720)], [
    { unit: 'hours', amount: 24 }, { unit: 'days', amount: 3 }, { unit: 'days', amount: 7 }, { unit: 'days', amount: 30 },
  ]);
  assert.deepEqual(['F', 'm', 'U', 'female', 'other'].map(genderCode), ['f', 'm', 'u', 'f', 'u']);
});

test('ids de claim: cortos, legibles y dentro del alfabeto de la marca', () => {
  assert.equal(shortId('00000002-0000-4000-8000-000000000D01'), '000000000d01');
  assert.equal(claimSlug('55+'), '55-mas');
  assert.equal(claimSlug('Ñandú'), 'nandu');
  assert.equal(claimSlug('***'), 'x');
});

test('el perfil guardado se lee de vuelta; uno roto o de otra versión es «sin calcular»', () => {
  const perfil = buildPerfil(entradasLaura());
  const guardado: StoredPerfil = {
    version: 3, computedAt: perfil.computedAt, perfil,
    narrative: { text: 'Hola.', source: 'template', model: null, writtenAt: perfil.computedAt, fallback: 'no_model' },
  };
  const ida = JSON.parse(JSON.stringify(guardado));
  assert.deepEqual(parseStoredPerfil(ida), guardado);
  assert.equal(parseStoredPerfil(null), null);
  // Un perfil de otra versión (v2: el porqué con el video dentro de su grupo) se recalcula.
  assert.equal(parseStoredPerfil({ ...ida, version: 2 }), null);
  assert.equal(parseStoredPerfil({ ...ida, narrative: { ...ida.narrative, source: 'otro' } }), null);
  const claimRoto = { ...ida, perfil: { ...ida.perfil, claims: [{ ...ida.perfil.claims[0], id: 'Con Mayúsculas' }] } };
  assert.equal(parseStoredPerfil(claimRoto), null);
  const sinClave = { ...ida, perfil: { ...ida.perfil, claims: [{ ...ida.perfil.claims[0], key: 'inventada' }] } };
  assert.equal(parseStoredPerfil(sinClave), null);
});

test('un perfil guardado a medio escribir no llega a la pantalla: cada arreglo que recorre se comprueba', () => {
  const perfil = buildPerfil(entradasLaura());
  const ida = JSON.parse(JSON.stringify({
    version: 3, computedAt: perfil.computedAt, perfil,
    narrative: { text: 'Hola.', source: 'template', model: null, writtenAt: perfil.computedAt, fallback: 'no_model' },
  }));
  const con = (cambio: (p: Record<string, any>) => void) => {
    const copia = structuredClone(ida);
    cambio(copia.perfil);
    return parseStoredPerfil(copia);
  };
  assert.equal(con((p) => { delete p.audience.lines; }), null, 'audience sin lines');
  assert.equal(con((p) => { p.audience.nonFollowers = {}; }), null);
  assert.equal(con((p) => { delete p.identity.networks; }), null);
  assert.equal(con((p) => { p.formats.tone = null; }), null);
  assert.equal(con((p) => { p.formats.pieces[0].claimId = 7; }), null);
  assert.equal(con((p) => { p.socialProof[0].claimIds = 'x'; }), null);
  assert.equal(con((p) => { p.rates.lines = undefined; }), null);
  assert.equal(con((p) => { delete p.performance.top[0].why.reasons; }), null);
  assert.equal(con((p) => { p.performance.medians[0].cutHours = '7'; }), null);
  // La portada y el enlace de un video solo pueden ser http(s): un «javascript:» a mano no llega a un src ni a un href.
  assert.equal(con((p) => { p.performance.top[0].coverUrl = 'javascript:alert(1)'; }), null);
  assert.equal(con((p) => { p.performance.top[0].url = 'javascript:alert(1)'; }), null);
  assert.equal(con((p) => { delete p.posts; }), null);
  assert.ok(con((p) => { p.performance.top[0].coverUrl = 'https://cdn.example.com/p.jpg'; }));
  assert.ok(con((p) => { p.performance.top[0].coverUrl = '/demo/portadas/1.svg'; }));
  assert.equal(con((p) => { p.performance.top[0].coverUrl = '//evil.example.com/p.jpg'; }), null);
  // Sin tarifario es válido: rates null.
  assert.ok(con((p) => { p.rates = null; }));
  // El enlace del origen de una cifra también es un href: solo http(s).
  assert.equal(con((p) => { p.claims.find((c: { source: { url?: unknown } }) => c.source.url).source.url = 'javascript:alert(1)'; }), null);
});

test('un enlace o una portada sin esquema se sanea al calcular: el perfil se guarda y se lee, con null', () => {
  const entradas = entradasLaura();
  // Lo que deja la importación CSV: la url tal cual venga, sin https://.
  const d01 = entradas.posts.find((p) => p.id.endsWith('d01'))!;
  d01.url = 'www.tiktok.com/@laura/video/1';
  d01.coverUrl = 'cdn.example.com/d01.jpg';
  const perfil = buildPerfil(entradas);
  const mejor = perfil.performance.top.find((v) => v.postId === d01.id)!;
  assert.equal(mejor.url, null);
  assert.equal(mejor.coverUrl, null);
  // Las cifras del video siguen, con su origen sin enlace.
  assert.equal(claimById(perfil, mejor.multipleClaimId)!.source.url, null);
  assert.ok(perfil.posts.every((x) => x.url === null || x.url.startsWith('https://')));
  const guardado = JSON.parse(JSON.stringify({
    version: 3, computedAt: perfil.computedAt, perfil,
    narrative: { text: 'Hola.', source: 'template', model: null, writtenAt: perfil.computedAt, fallback: 'no_model' },
  }));
  const leido = parseStoredPerfil(guardado);
  assert.ok(leido, 'el perfil con una url sin esquema se lee: no queda «sin calcular»');
  assert.equal(leido.perfil.performance.top.find((v) => v.postId === d01.id)!.url, null);
  // Con esquema, se conserva; con espacios alrededor, se recorta.
  assert.equal(webUrlOrNull(' https://www.tiktok.com/@laura/video/1 '), 'https://www.tiktok.com/@laura/video/1');
  assert.equal(webUrlOrNull('HTTP://x.co/a'), 'HTTP://x.co/a');
  assert.equal(webUrlOrNull('javascript:alert(1)'), null);
  assert.equal(webUrlOrNull('https://'), null);
  assert.equal(webUrlOrNull(undefined), null);
  // Una portada puede ser, además, una ruta de la propia aplicación (las de la demostración); otro host sin esquema, no.
  assert.equal(coverSrcOrNull('/demo/portadas/1.svg'), '/demo/portadas/1.svg');
  assert.equal(coverSrcOrNull('//evil.example.com/x.jpg'), null);
  assert.equal(coverSrcOrNull('/\\evil.example.com/x.jpg'), null);
  assert.equal(coverSrcOrNull('https://p16.tiktokcdn.com/x.jpg'), 'https://p16.tiktokcdn.com/x.jpg');
  assert.equal(coverSrcOrNull('javascript:alert(1)'), null);
  // Solo las portadas de la demostración: otra ruta de la aplicación sería un GET con las cookies de quien mira.
  assert.equal(coverSrcOrNull('/auth/salir'), null);
  assert.equal(coverSrcOrNull('/demo/portadas/../../auth/salir'), null);
  assert.equal(coverSrcOrNull('/demo/portadas/1.svg?x=/auth/salir'), null);
  // Y las externas, solo https: una http es contenido mixto.
  assert.equal(coverSrcOrNull('http://p16.tiktokcdn.com/x.jpg'), null);
});

test('los mejores salen de todo el historial con puntaje; formatos y tono, solo de los recientes', () => {
  const e = entradasLaura();
  // Un breakout de hace dos años que ya no está entre los recientes.
  const viejo = {
    ...e.posts[0]!, id: '00000002-0000-4000-8000-0000000000a1', url: 'https://example.com/a1', coverUrl: null,
    title: 'El pan de bono que lo empezó todo', caption: 'El pan de bono que lo empezó todo', isBrandedContent: false,
    publishedAt: '2024-09-01T12:00:00.000Z',
    score: { viewsVsMedian: 9.4, viewsAtCut: 590000, outlierTier: 'breakout' as const, ageHoursCut: 168, computedAt: null, baseline: null },
  };
  const conHistorial = { ...e, scoredPosts: [...e.posts.filter((p) => p.score), viejo] };
  const p = buildPerfil(conHistorial);
  assert.equal(p.performance.top[0]!.postId, viejo.id);
  assert.equal(p.performance.top.length, 5);
  // «Entre N videos con puntaje» cuenta el historial, no solo los recientes.
  assert.equal(claimById(p, p.performance.scoredClaimId)!.value, 8);
  // Formatos y captions no cambian: son los de los recientes.
  const soloRecientes = buildPerfil(e);
  assert.deepEqual(p.formats, soloRecientes.formats);
  // El viejo está en el índice de posts para enlazarlo desde su agregado.
  assert.ok(p.posts.some((x) => x.postId === viejo.id));
});
