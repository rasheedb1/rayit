/**
 * VEN-11 · el perfil comercial: el cálculo puro (claims, los cinco
 * mejores y su porqué, audiencia, formatos y tono, prueba social,
 * tarifas) y lo que se lee de los captions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerfil, claimById, claimSlug, shortId, type PerfilComercial } from '../src/outreach/perfil.ts';
import {
  contentOf, durationBucketOf, durationVsTypical, hookFromAnalysis, hookOf, median, pieceOf, toneTraitsOf,
} from '../src/outreach/perfil-captions.ts';
import { parseStoredPerfil, type StoredPerfil } from '../src/outreach/perfil-guardado.ts';
import { entradasLaura } from './fixtures/perfil-entradas.ts';

/** Todos los ids que citan las secciones: cada uno tiene que estar en claims. */
function idsCitados(p: PerfilComercial): string[] {
  const ids: (string | null)[] = [
    ...p.identity.networks.map((n) => n.followersClaimId),
    ...p.audience.lines.map((a) => a.claimId),
    ...p.audience.nonFollowers.map((n) => n.claimId),
    ...p.performance.medians.map((m) => m.claimId),
    p.performance.scoredClaimId,
    ...p.performance.top.flatMap((v) => [v.multipleClaimId, v.viewsClaimId, v.durationClaimId]),
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
  const x = claimById(p, primero.multipleClaimId)!;
  assert.deepEqual(x, {
    id: 'video-000000000d01-x', kind: 'multiple', label: 'Veces su mediana de Instagram que hizo «Cold brew en casa en 3 pasos»',
    value: 5.971, unit: 'x',
    source: { table: 'post_score', id: '00000002-0000-4000-8000-000000000d01', field: 'views_vs_median', url: 'https://example.com/d01' },
  });
  assert.equal(claimById(p, primero.viewsClaimId)!.value, 412000);
  assert.equal(claimById(p, primero.viewsClaimId)!.source.field, 'views_at_cut');
  assert.equal(claimById(p, primero.durationClaimId)!.source.table, 'post');
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

test('el porqué de cada video sale del gancho, la pieza, el tipo y la duración', () => {
  const p = buildPerfil(entradasLaura());
  const [breakout, arepa, desayunos, coldbrew, pasta] = p.performance.top;
  assert.deepEqual(breakout!.why, {
    hook: 'promesa', hookSource: 'caption', piece: 'reel', content: 'colaboracion', duration: 'corto', durationVsTypical: 'similar',
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
  assert.equal(f.source.table, 'audience_breakdown');
  assert.equal(f.source.id, 'a5');
  // La mediana de no seguidores que no existe no se inventa.
  assert.deepEqual(p.audience.nonFollowers.map((n) => n.platformId), ['tiktok']);
});

test('identidad, medianas por red y tarifas llevan su fila de origen', () => {
  const p = buildPerfil(entradasLaura());
  assert.deepEqual(p.identity.networks.map((n) => n.platformId), ['tiktok', 'instagram', 'youtube']);
  assert.equal(p.identity.networks[2]!.followersClaimId, null);
  assert.deepEqual(claimById(p, 'seguidores-tiktok')!.source, { table: 'account_metric_snapshot', id: '902', field: 'followers' });
  assert.deepEqual(p.performance.medians.map((m) => m.platformId), ['tiktok', 'instagram', 'youtube']);
  assert.deepEqual(claimById(p, 'mediana-tiktok')!.source, { table: 'creator_baseline', id: 'b-tt', field: 'median_views' });
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
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(toneTraitsOf('¿Tú qué le pones? 🍳 #arepa', ['arepa']), ['emojis', 'tutea', 'preguntas', 'breve', 'hashtags']);
  assert.deepEqual(toneTraitsOf('   ', []), []);
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
    version: 1, computedAt: perfil.computedAt, perfil,
    narrative: { text: 'Hola.', source: 'template', model: null, writtenAt: perfil.computedAt, fallback: 'no_model' },
  };
  const ida = JSON.parse(JSON.stringify(guardado));
  assert.deepEqual(parseStoredPerfil(ida), guardado);
  assert.equal(parseStoredPerfil(null), null);
  assert.equal(parseStoredPerfil({ ...ida, version: 2 }), null);
  assert.equal(parseStoredPerfil({ ...ida, narrative: { ...ida.narrative, source: 'otro' } }), null);
  const claimRoto = { ...ida, perfil: { ...ida.perfil, claims: [{ ...ida.perfil.claims[0], id: 'Con Mayúsculas' }] } };
  assert.equal(parseStoredPerfil(claimRoto), null);
});
