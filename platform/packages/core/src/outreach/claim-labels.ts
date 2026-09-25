/**
 * Los textos y el formato de las afirmaciones (VEN-12), en un solo lugar
 * por idioma. @mc/db arma los claims desde la base y toma de aquí cómo se
 * llama cada uno y cómo se escribe su cifra con el locale del workspace
 * (Intl, nunca a mano): lo mismo que verá la marca en el mensaje.
 */
import type { ClaimUnit } from './claims.ts';

export type ClaimLang = 'es' | 'en';

/** 'es-CO' → es, 'en-US' → en; lo demás, es. */
export function claimLang(locale: string | null | undefined): ClaimLang {
  return (locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'es';
}

const PLATFORMS: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook' };
export const platformName = (id: string) => PLATFORMS[id] ?? id;

const GENDER: Record<ClaimLang, Record<string, string>> = {
  es: { F: 'mujeres', M: 'hombres' },
  en: { F: 'women', M: 'men' },
};

/** Una frase corta para el título de un video: su caption sin hashtags ni menciones, en 60 caracteres. */
export function postTitle(caption: string | null | undefined, lang: ClaimLang): string {
  const clean = (caption ?? '').replace(/[#@][\p{L}\p{N}._]+/gu, '').replace(/\s+/g, ' ').trim();
  if (!clean) return lang === 'en' ? 'a video' : 'un video';
  const cut = [...clean].length > 60 ? `${[...clean].slice(0, 57).join('').trimEnd()}…` : clean;
  return `«${cut}»`;
}

export const CLAIM_LABELS = {
  es: {
    medianViews: (p: string) => `Mediana de views en ${platformName(p)} a 7 días`,
    medianEngagement: (p: string) => `Interacción mediana en ${platformName(p)}`,
    audienceAge: (p: string, bucket: string) => `Seguidores de ${bucket} años en ${platformName(p)}`,
    audienceGender: (p: string, bucket: string) => `Seguidores ${GENDER.es[bucket] ?? bucket} en ${platformName(p)}`,
    audienceCountry: (p: string, country: string) => `Seguidores en ${country} en ${platformName(p)}`,
    followersTotal: () => 'Seguidores en total, en todas las redes',
    followers: (p: string) => `Seguidores en ${platformName(p)}`,
    postViews: (title: string, p: string) => `Views de ${title} en ${platformName(p)}`,
    postVsMedian: (title: string) => `${title}: views frente a la mediana propia`,
    campaignViews: (brand: string) => `Views de la campaña con ${brand}`,
    campaignNonFollowers: (brand: string) => `Alcance en no seguidores de la campaña con ${brand}`,
    campaignRedemptions: (brand: string) => `Códigos redimidos en la campaña con ${brand}`,
    campaignFollowers: (brand: string) => `Seguidores que ganó ${brand} con la campaña`,
    signalActiveAds: (brand: string) => `Anuncios activos de ${brand}`,
  },
  en: {
    medianViews: (p: string) => `Median 7-day views on ${platformName(p)}`,
    medianEngagement: (p: string) => `Median engagement on ${platformName(p)}`,
    audienceAge: (p: string, bucket: string) => `Followers aged ${bucket} on ${platformName(p)}`,
    audienceGender: (p: string, bucket: string) => `${GENDER.en[bucket] ?? bucket} among followers on ${platformName(p)}`,
    audienceCountry: (p: string, country: string) => `Followers in ${country} on ${platformName(p)}`,
    followersTotal: () => 'Total followers across networks',
    followers: (p: string) => `Followers on ${platformName(p)}`,
    postViews: (title: string, p: string) => `Views of ${title} on ${platformName(p)}`,
    postVsMedian: (title: string) => `${title}: views vs. own median`,
    campaignViews: (brand: string) => `Views of the campaign with ${brand}`,
    campaignNonFollowers: (brand: string) => `Non-follower reach of the campaign with ${brand}`,
    campaignRedemptions: (brand: string) => `Codes redeemed in the campaign with ${brand}`,
    campaignFollowers: (brand: string) => `Followers ${brand} gained with the campaign`,
    signalActiveAds: (brand: string) => `Active ads by ${brand}`,
  },
} as const;

/** El nombre de un país por su código, en el idioma del workspace (Intl.DisplayNames). */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Cómo se escribe la cifra de un claim en el mensaje, con el locale del workspace. */
export function formatClaimValue(value: number, unit: ClaimUnit, locale: string, currency?: string | null): string {
  switch (unit) {
    case 'count':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
    case 'share':
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: value < 0.1 ? 1 : 0 }).format(value);
    case 'multiple':
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}×`;
    case 'money':
      return new Intl.NumberFormat(locale, { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: 0 }).format(value);
  }
}
