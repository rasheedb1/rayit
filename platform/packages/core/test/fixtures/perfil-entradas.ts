/**
 * Entradas del perfil comercial con la forma del seed de Laura (seed
 * 0002–0004): los mismos títulos, captions, medianas y campañas, en
 * pequeño. Las pruebas del perfil y de la narrativa arman el perfil desde
 * aquí, sin base.
 */
import type { PerfilInputs, PerfilPostInput } from '../../src/outreach/perfil.ts';

const CREADORA = '00000002-0000-4000-8000-000000000003';

function post(n: string, p: Partial<PerfilPostInput> & Pick<PerfilPostInput, 'platformId'>): PerfilPostInput {
  return {
    id: `00000002-0000-4000-8000-000000000${n}`,
    url: `https://example.com/${n}`,
    title: null,
    caption: null,
    hashtags: [],
    surface: 'feed',
    mediaType: 'video',
    durationS: 38,
    isBrandedContent: false,
    publishedAt: '2026-09-01T12:00:00.000Z',
    hookType: null,
    score: null,
    ...p,
  };
}

/**
 * Las líneas base contra las que se puntuaron los videos: las de la
 * mediana del perfil (168 h) y la de Instagram a 30 días, que es la que
 * hace verdad el 5,97× del reel de Café Alma (412 000 / 69 000).
 */
const BASES = {
  'b-tt': { id: 'b-tt', medianViews: 115446, ageHoursCut: 168, computedAt: '2026-09-25T00:00:00.000Z' },
  'b-ig': { id: 'b-ig', medianViews: 62177, ageHoursCut: 168, computedAt: '2026-09-25T00:00:00.000Z' },
  'b-ig-720': { id: '00000002-0000-4000-8000-ba5207200001', medianViews: 69000, ageHoursCut: 720, computedAt: '2026-09-25T00:00:00.000Z' },
} as const;

const score = (
  x: number, views: number, tier: 'good' | 'outlier' | 'breakout' | 'normal' | 'under', cut = 168, base: keyof typeof BASES | null = null,
) => ({
  viewsVsMedian: x, viewsAtCut: views, outlierTier: tier, ageHoursCut: cut, computedAt: '2026-09-25T00:00:00.000Z',
  baseline: base ? { ...BASES[base] } : null,
});

export function entradasLaura(): PerfilInputs {
  return {
    creator: {
      id: CREADORA,
      displayName: 'Laura Méndez',
      handle: 'laura.cocinafacil',
      bio: 'Cocina fácil para más de 400 mil personas en Colombia.',
      country: 'CO',
      languages: ['es'],
      nicheSlugs: ['cocina'],
      nicheNames: ['Cocina'],
    },
    connections: [
      { id: 'c-ig', platformId: 'instagram', handle: 'laura.cocinafacil', status: 'active', followers: 184000, followersSnapshotId: '901', followersDay: '2026-09-24' },
      { id: 'c-tt', platformId: 'tiktok', handle: 'laura.cocinafacil', status: 'active', followers: 243000, followersSnapshotId: '902', followersDay: '2026-09-24' },
      { id: 'c-yt', platformId: 'youtube', handle: 'lauracocinafacil', status: 'active', followers: null, followersSnapshotId: null, followersDay: null },
    ],
    audience: [
      { id: 'a1', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'age', bucket: '25-34', share: 0.37, day: '2026-09-24' },
      { id: 'a2', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'age', bucket: '18-24', share: 0.34, day: '2026-09-24' },
      { id: 'a3', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'age', bucket: '35-44', share: 0.15, day: '2026-09-24' },
      { id: 'a4', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'age', bucket: '55+', share: 0.03, day: '2026-09-24' },
      { id: 'a5', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'gender', bucket: 'F', share: 0.64, day: '2026-09-24' },
      { id: 'a6', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'gender', bucket: 'M', share: 0.36, day: '2026-09-24' },
      { id: 'a7', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'country', bucket: 'OTHER', share: 0.2, day: '2026-09-24' },
      { id: 'a8', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'country', bucket: 'CO', share: 0.69, day: '2026-09-24' },
      { id: 'a9', platformId: 'tiktok', connectionId: 'c-tt', dimension: 'country', bucket: 'MX', share: 0.13, day: '2026-09-24' },
      { id: 'a10', platformId: 'instagram', connectionId: 'c-ig', dimension: 'gender', bucket: 'F', share: 0.7, day: '2026-09-24' },
    ],
    nonFollowers: [
      { platformId: 'tiktok', medianShare: 0.58, postIds: ['p1', 'p2'], asOf: '2026-09-24T06:00:00.000Z' },
      { platformId: 'youtube', medianShare: null, postIds: [], asOf: null },
    ],
    baselines: [
      { id: 'b-yt', platformId: 'youtube', ageHoursCut: 168, medianViews: 41310, sampleSize: 11, isReliable: true, computedAt: '2026-09-25T00:00:00.000Z' },
      { id: 'b-tt', platformId: 'tiktok', ageHoursCut: 168, medianViews: 115446, sampleSize: 17, isReliable: true, computedAt: '2026-09-25T00:00:00.000Z' },
      { id: 'b-ig', platformId: 'instagram', ageHoursCut: 168, medianViews: 62177, sampleSize: 16, isReliable: true, computedAt: '2026-09-25T00:00:00.000Z' },
    ],
    posts: [
      post('d01', { platformId: 'instagram', surface: 'reels', title: 'Cold brew en casa en 3 pasos', caption: 'Cold brew en casa en 3 pasos ☕ Con @cafealma · código LAURA15', durationS: 41, isBrandedContent: true, coverUrl: 'https://example.com/d01.jpg', score: score(5.971, 412000, 'breakout', 720, 'b-ig-720') }),
      post('d06', { platformId: 'tiktok', title: 'La arepa que se hace sin plancha', caption: 'Reto: arepa sin plancha y sin que se pegue. Sí se puede 🫓 #arepa #recetafacil', durationS: 34, hashtags: ['arepa', 'recetafacil'], score: score(3.71, 395810, 'outlier', 72) }),
      post('d18', { platformId: 'instagram', surface: 'reels', title: 'Tres desayunos con dos ingredientes', caption: 'Tres desayunos con dos ingredientes cada uno. Guárdalo para mañana 🍳 #desayuno', durationS: 41, hashtags: ['desayuno'], score: score(2.662, 165485, 'outlier', 168, 'b-ig') }),
      post('d02', { platformId: 'tiktok', title: 'El cold brew que me salva las mañanas', caption: 'El cold brew que me salva las mañanas 🧊 #ad @cafealma.co', durationS: 34, isBrandedContent: true, score: score(2.469, 300000, 'outlier', 720) }),
      post('d28', { platformId: 'youtube', surface: 'shorts', title: 'Pasta cremosa en cuatro minutos', caption: 'Pasta cremosa en cuatro minutos, sin crema de leche #shorts', durationS: 55, score: score(2.359, 77095, 'outlier', 72) }),
      post('d07', { platformId: 'tiktok', title: 'El error que arruina tu arroz', caption: 'El error que arruina tu arroz (y lo cometemos todos) 🍚 #arroz', durationS: 38, score: score(2.02, 233187, 'outlier', 168, 'b-tt') }),
      post('d33', { platformId: 'facebook', title: '¿Qué cocino un lunes sin ganas?', caption: '¿Qué cocino un lunes sin ganas de cocinar? 🙃 #cena', durationS: 62, score: score(1.557, 30669, 'good') }),
      post('d40', { platformId: 'tiktok', title: null, caption: 'Mi sopa de los domingos', durationS: 60, score: null }),
    ],
    campaigns: [
      {
        id: '00000003-0000-4000-8000-000000ca0001', name: 'Lanzamiento cold brew', companyName: 'Café Alma', status: 'reported',
        result: { views: 712000, brandFollowersGained: 1240, codeRedemptions: null, attributedRevenue: null, currency: 'COP', viewsVsMedian: null },
      },
      {
        id: '00000003-0000-4000-8000-000000ca0004', name: '3 historias · jun', companyName: 'Hogar Lindo', status: 'reported',
        result: { views: 94000, brandFollowersGained: null, codeRedemptions: null, attributedRevenue: '1250000.50', currency: 'COP', viewsVsMedian: null },
      },
      {
        id: '00000003-0000-4000-8000-000000ca0009', name: 'Sin cifras', companyName: 'Nadie', status: 'closed',
        result: { views: null, brandFollowersGained: null, codeRedemptions: null, attributedRevenue: null, currency: null, viewsVsMedian: null },
      },
    ],
    rateCard: {
      id: '00000004-0000-4000-8000-0000007a1f01', currency: 'COP', computedAt: '2026-09-20T00:00:00.000Z',
      items: [
        { id: '00000004-0000-4000-8000-0000007a1101', labelEs: 'TikTok dedicado', platformId: 'tiktok', priceLow: '5200000.00', priceHigh: '8080000.00' },
        { id: '00000004-0000-4000-8000-0000007a1103', labelEs: 'Historias (3)', platformId: 'instagram', priceLow: '2150000.00', priceHigh: '3320000.00' },
      ],
    },
    cutHours: 168,
    computedAt: '2026-09-25T10:00:00.000Z',
  };
}

/**
 * Cuatro videos más, largos y flojos, en Facebook: con ellos los videos
 * cortos de Laura tienen contra qué compararse (al menos tres a cada
 * lado sin contar el que se explica).
 */
export function entradasConVideosLargos(): PerfilInputs {
  const e = entradasLaura();
  const largos: PerfilPostInput[] = [0.5, 0.6, 0.7, 0.8].map((x, i) => ({
    id: `00000002-0000-4000-8000-00000000f0${i}0`, platformId: 'facebook', url: `https://example.com/f${i}`,
    title: `Receta larga ${['uno', 'dos', 'tres', 'cuatro'][i]}`, caption: 'Receta larga de domingo', hashtags: [],
    surface: 'feed', mediaType: 'video', durationS: 180, isBrandedContent: false, publishedAt: '2026-08-01T12:00:00.000Z',
    hookType: null, score: { viewsVsMedian: x, viewsAtCut: 20000, outlierTier: 'under', ageHoursCut: 168, computedAt: null, baseline: null },
  }));
  e.posts.push(...largos);
  return e;
}
