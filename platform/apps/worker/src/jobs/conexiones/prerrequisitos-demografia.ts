/**
 * Qué se le puede pedir a cada cuenta ANTES de llamar, y qué fila de
 * `metric_requirement` (0011, 0039) explica lo que no.
 *
 * Es el corazón de CON-7 y por eso está aquí, aparte del job y sin nada
 * de base ni de red: se prueba en milisegundos y el job solo la obedece.
 * El criterio de terminado de la historia dice «ninguna llamada a la API
 * se hace cuando el prerrequisito falla», así que esta decisión se toma
 * con lo que ya está en la base y nunca gastando una llamada.
 *
 * Regla que se repite en los tres caminos: **un nulo no es un cero**. Si
 * la cuenta todavía no tiene un `account_metric_snapshot`, no sabemos
 * cuántos seguidores tiene, y eso NO es «tiene menos de cien»: se llama,
 * y si la plataforma contesta que no le bastan, ahí se anota el
 * requisito (`requirementFromApiError`).
 */
import { INSTAGRAM_NOT_ENOUGH_FOLLOWERS_SUBCODE, isPlatformApiError, YOUTUBE_ANALYTICS_SCOPE, type InstagramBreakdown } from '@mc/connectors';

/** `metric_requirement.metric_group` del que habla esta historia. */
export const DEMOGRAPHICS_GROUP = 'demografia_de_cuenta';

/** El número que nombra el requisito `min_followers_100` de 0011. */
export const MIN_FOLLOWERS = 100;

/** Los cuatro cortes que Instagram entrega de sus seguidores. */
export const INSTAGRAM_BREAKDOWNS: readonly InstagramBreakdown[] = ['age', 'gender', 'country', 'city'];

/** Scope de la Accounts API de TikTok que entrega la audiencia de la cuenta. */
export const TIKTOK_AUDIENCE_SCOPE = 'user.insights';

/** Scope de Instagram Login que abre `me/insights`. */
export const INSTAGRAM_INSIGHTS_SCOPE = 'instagram_business_manage_insights';

/**
 * Los 28 días que terminan AYER. TikTok y YouTube entregan los datos con
 * 24–48 h de retraso (nota de 0011), así que pedir «hasta hoy» devuelve
 * un día a medio llenar que mañana valdría otra cosa.
 */
export const WINDOW_DAYS = 28;

/** Lo que el job sabe de la cuenta antes de llamar a nadie. */
export interface DemographicsAccount {
  platformId: string;
  accessMode: string;
  accountType: string | null;
  /** social_connection.status: 'needs_reauth' es una autorización que se cayó. */
  status: string;
  scopes: readonly string[];
  /** Seguidores del último snapshot, o null si nunca se leyó. */
  followers: number | null;
}

export type DemographicsPlan =
  | { platform: 'instagram'; breakdowns: readonly InstagramBreakdown[] }
  | { platform: 'tiktok' }
  | { platform: 'youtube' };

export type DemographicsDecision =
  | { ok: true; plan: DemographicsPlan }
  | { ok: false; requirementId: string }
  /** La red no entrega demografía de cuenta por ninguna vía: ni se llama ni se explica con un requisito. */
  | { ok: false; requirementId: null; reason: string };

function missing(requirementId: string): DemographicsDecision {
  return { ok: false, requirementId };
}

/**
 * La decisión, por red. El orden importa: se nombra el primer requisito
 * que falta, que es el que la persona tiene que resolver primero. De
 * nada sirve decirle «te faltan seguidores» a quien todavía no ha
 * autorizado la cuenta.
 */
export function planDemographics(acc: DemographicsAccount): DemographicsDecision {
  // Una cuenta con el token caído está tan lejos del dato como una que
  // nunca se autorizó, y por la misma razón: hace falta que el dueño
  // vuelva a autorizarla. Sin esto, la cuenta se quedaba fuera del job y
  // su celda vacía no tenía ninguna explicación.
  const authorized = acc.accessMode === 'direct_oauth' && acc.status !== 'needs_reauth';
  const fewFollowers = acc.followers !== null && acc.followers < MIN_FOLLOWERS;

  switch (acc.platformId) {
    case 'instagram': {
      if (!authorized) return missing('ig.demographics.auth');
      if (acc.accountType === 'personal') return missing('ig.insights.account_type');
      if (!acc.scopes.includes(INSTAGRAM_INSIGHTS_SCOPE)) return missing('ig.insights.account_type');
      if (fewFollowers) return missing('ig.demographics');
      return { ok: true, plan: { platform: 'instagram', breakdowns: INSTAGRAM_BREAKDOWNS } };
    }
    case 'tiktok': {
      if (!authorized) return missing('tt.audience.auth');
      // Una cuenta personal no puede conseguir el scope de audiencia: es
      // de la app de negocio, y para eso hay que pasar la cuenta a
      // Business (y renunciar a Creator Rewards). Decirle «vuelve a
      // conectarte y acepta el permiso» sería mandarla a una puerta que
      // no abre, así que tiene su propia fila.
      if (acc.accountType === 'personal') return missing('tt.audience.account_type');
      if (!acc.scopes.includes(TIKTOK_AUDIENCE_SCOPE)) return missing('tt.audience.scope');
      if (fewFollowers) return missing('tt.audience_age');
      return { ok: true, plan: { platform: 'tiktok' } };
    }
    case 'youtube': {
      if (!authorized) return missing('yt.demographics.auth');
      if (!acc.scopes.includes(YOUTUBE_ANALYTICS_SCOPE)) return missing('yt.analytics.scope');
      // YouTube no exige un mínimo de suscriptores: Analytics devuelve
      // una tabla vacía cuando hay pocas vistas, y eso ya se ve.
      return { ok: true, plan: { platform: 'youtube' } };
    }
    default:
      return {
        ok: false,
        requirementId: null,
        reason: 'la red no entrega demografía de cuenta por API (Meta la eliminó en 2024)',
      };
  }
}

/**
 * Cuando la API contesta con un error pese a haber pasado la evaluación
 * previa, qué requisito lo explica. `null` = no es un requisito, es un
 * fallo de verdad y el job lo trata como tal.
 *
 * Solo se traduce lo que la plataforma identifica sin ambigüedad. El
 * `code` 100 de Meta vale para cualquier parámetro malo, así que aquí
 * cuenta el `error_subcode`: sin él, un defecto nuestro se disfrazaría
 * de «te faltan seguidores» y nadie lo arreglaría nunca.
 */
export function requirementFromApiError(platformId: string, err: unknown): string | null {
  if (!isPlatformApiError(err)) return null;
  if (err.kind !== 'permanent') return null;
  if (platformId === 'instagram' && err.subcode === INSTAGRAM_NOT_ENOUGH_FOLLOWERS_SUBCODE) return 'ig.demographics';
  return null;
}

/**
 * Qué dimensiones deja escritas cada plan si la API responde entera. El
 * job compara con lo que ya hay de hoy: así una corrida que se cortó a
 * medias (un corte de Instagram que falló) la completa la siguiente, en
 * vez de darse por hecha porque había «algo» del día.
 */
export function dimensionsOf(plan: DemographicsPlan): readonly string[] {
  if (plan.platform === 'instagram') return plan.breakdowns;
  if (plan.platform === 'tiktok') return ['country', 'gender', 'age'];
  return ['age_gender', 'country'];
}

/** El rango que se le pide a TikTok y a YouTube: [hace 28 días, ayer], en 'YYYY-MM-DD' UTC. */
export function analyticsWindow(now: Date): { startDate: string; endDate: string } {
  const end = new Date(now.getTime() - 86_400_000);
  const start = new Date(end.getTime() - (WINDOW_DAYS - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
